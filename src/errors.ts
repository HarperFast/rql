export class QueryError extends Error {
	statusCode = 400;
	constructor(message: string) {
		super(message);
		this.name = this.constructor.name;
	}
}

export class SyntaxViolation extends QueryError {}
