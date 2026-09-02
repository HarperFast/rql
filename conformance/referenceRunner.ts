/**
 * Supervises the out-of-process reference parser.
 *
 * Every path settles the request it was given: a parse that never returns becomes `timeout`,
 * and a worker that dies, will not start, or cannot be replaced becomes `harness-error` —
 * neither of which `classify` will treat as agreement. A promise left unsettled here would
 * hang the whole corpus instead.
 */

import { type ChildProcess, fork } from 'node:child_process';
import type { Outcome } from './canonical.ts';

export type ReferenceOutcomes = { strict: Outcome; deferred: Outcome };

export type ReferenceRunnerOptions = {
	/** Path to the worker script to fork. */
	workerPath: string;
	/** Wall-clock budget for one parse. */
	timeoutMs: number;
	/** Budget for a worker to load and report itself ready. */
	startupTimeoutMs: number;
	/** Where a worker's stderr goes. Inherited by default so real failures are visible. */
	stderr?: 'inherit' | 'ignore';
};

type Pending = { resolve: (outcomes: ReferenceOutcomes) => void; timer: NodeJS.Timeout };

const both = (outcome: Outcome): ReferenceOutcomes => ({ strict: outcome, deferred: outcome });

export class ReferenceRunner {
	readonly #options: ReferenceRunnerOptions;
	#child: ChildProcess | undefined;
	#pending = new Map<number, Pending>();
	#nextId = 0;
	/** Set once the worker cannot be replaced; every later parse then fails fast. */
	#dead: string | undefined;


	constructor(options: ReferenceRunnerOptions) {
		this.#options = options;
	}

	get deadReason(): string | undefined {
		return this.#dead;
	}

	/** Hand every in-flight parse the same failure, rather than leaving it pending. */
	#settleAll(reason: string): void {
		const pending = this.#pending;
		this.#pending = new Map();
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.resolve(both({ status: 'harness-error', error: reason }));
		}
	}

	async #spawn(): Promise<void> {
		const child = fork(this.#options.workerPath, [], { stdio: ['ignore', 'ignore', this.#options.stderr ?? 'inherit', 'ipc'] });
		this.#child = child;
		this.#pending = new Map();

		child.on('message', (message: { type?: string; id?: number; strict?: Outcome; deferred?: Outcome }) => {
			if (message?.type !== 'result' || message.id === undefined) return;
			const entry = this.#pending.get(message.id);
			if (!entry) return;
			this.#pending.delete(message.id);
			clearTimeout(entry.timer);
			entry.resolve({ strict: message.strict as Outcome, deferred: message.deferred as Outcome });
		});

		const onGone = (reason: string): void => {
			if (this.#child !== child) return;
			this.#dead ??= reason;
			this.#settleAll(reason);
		};
		child.on('exit', (code, signal) => onGone(`the reference worker exited (code ${code}, signal ${signal})`));
		child.on('error', (error) => onGone(`the reference worker failed to run: ${error.message}`));

		await new Promise<void>((ready, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`the reference worker did not start within ${this.#options.startupTimeoutMs}ms`)),
				this.#options.startupTimeoutMs
			);
			const settle = (finish: () => void): void => {
				clearTimeout(timer);
				finish();
			};
			child.once('message', (message: { type?: string }) =>
				settle(() => (message?.type === 'ready' ? ready() : reject(new Error('the reference worker sent no ready message'))))
			);
			child.once('error', (error) => settle(() => reject(error)));
			child.once('exit', (code, signal) =>
				settle(() => reject(new Error(`the reference worker exited before starting (code ${code}, signal ${signal})`)))
			);
		});
		this.#dead = undefined;
	}

	async start(): Promise<void> {
		await this.#spawn();
	}

	/** On a timeout the worker is killed and replaced, so a wedged case costs only that case. */
	parse(query: string): Promise<ReferenceOutcomes> {
		if (this.#dead) return Promise.resolve(both({ status: 'harness-error', error: this.#dead }));
		const child = this.#child;
		if (!child) return Promise.resolve(both({ status: 'harness-error', error: 'the reference worker was never started' }));

		const id = this.#nextId++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				child.kill('SIGKILL');
				this.#spawn()
					.catch((error: Error) => {
						this.#dead = `the reference worker could not be restarted: ${error.message}`;
					})
					.finally(() => resolve(both({ status: 'timeout', ms: this.#options.timeoutMs })));
			}, this.#options.timeoutMs);
			this.#pending.set(id, { resolve, timer });
			child.send({ type: 'parse', id, query });
		});
	}

	stop(): void {
		this.#child?.kill();
	}
}
