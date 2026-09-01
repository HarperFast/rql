import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as dialect from 'rql/postgrest';
import * as root from 'rql';

describe('built PostgREST package surface', () => {
	it('exports the dialect parser and error from the built subpath', () => {
		assert.equal(typeof dialect.parsePostgrest, 'function');
		assert.ok(dialect.UnsupportedFeature.prototype instanceof root.QueryError);
		assert.deepEqual(dialect.parsePostgrest('or=(a.eq.1,b.eq.2)&limit=5'), {
			filter: {
				operator: 'or',
				terms: [
					{ path: ['a'], comparator: 'eq', value: 1 },
					{ path: ['b'], comparator: 'eq', value: 2 },
				],
			},
			limit: 5,
		});
	});

	it('does not export the dialect from the built Core entry point', () => {
		assert.equal('parsePostgrest' in root, false);
		assert.equal('UnsupportedFeature' in root, false);
	});
});
