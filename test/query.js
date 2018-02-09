define(function (require) {
	var test = require('intern!object'),
		assert = require('intern/chai!assert'),
		Query = require('../query').Query,
		parseQuery = require('../parser').parseQuery,
		JSON = require('intern/dojo/json'),
		supportsDateString = !isNaN(new Date('2009')),
		queryPairs = {
			arrays: {
				a: { name: 'and', args: [ 'a' ]},
				'(a)': { name: 'and', args: [[ 'a' ]]},
				'a,b,c': { name: 'and', args: [ 'a', 'b', 'c' ]},
				'(a,b,c)': { name: 'and', args: [[ 'a', 'b', 'c']]},
				'a(b)': { name: 'and', args: [{ name: 'a', args: [ 'b' ]}]},
				'a(b,c)': { name: 'and', args: [{ name: 'a', args: [ 'b', 'c' ]}]},
				'a((b),c)': { name: 'and', args: [{ name: 'a', args: [ [ 'b' ], 'c' ]}]},
				'a((b,c),d)': { name: 'and', args: [{ name: 'a', args: [ [ 'b', 'c' ], 'd' ]}]},
				'a(b/c,d)': { name: 'and', args: [{ name: 'a', args: [ [ 'b', 'c' ], 'd' ]}]},
				'a(b)&c(d(e))': { name: 'and', args:[
					{ name: 'a', args: [ 'b' ]},
					{ name: 'c', args: [ { name: 'd', args: [ 'e' ]} ]}
				]}
			},
			'dot-comparison': {
				// 'foo.bar=3': { name: 'and', args: [{ name: 'eq', args: [ 'foo.bar', 3 ]}]},
				'select(sub.name)': {
					name: 'and',
					args: [ { name: 'select', args: [ 'sub.name' ]} ],
					cache: { select: [ 'sub.name' ]}
				}
			},
			equality: {
				'eq(a,b)': { name: 'and', args:[{ name: 'eq', args: [ 'a', 'b' ]}]},
				// 'a=eq=b': 'eq(a,b)',
				// 'a=b': 'eq(a,b)'
			},
			inequality: {
				'ne(a,b)': { name: 'and', args: [{ name: 'ne', args: [ 'a', 'b' ]}]},
				// 'a=ne=b': 'ne(a,b)',
				// 'a!=b': 'ne(a,b)'
			},
			'less-than': {
				'lt(a,b)': { name: 'and', args: [{ name: 'lt', args: [ 'a', 'b' ]}]},
				// 'a=lt=b': 'lt(a,b)',
				// 'a<b': 'lt(a,b)'
			},
			'less-than-equals': {
				'le(a,b)': { name: 'and', args: [{ name: 'le', args: [ 'a','b' ]}]},
				// 'a=le=b': 'le(a,b)',
				// 'a<=b': 'le(a,b)'
			},
			'greater-than': {
				'gt(a,b)': { name: 'and', args: [{ name: 'gt', args: [ 'a', 'b' ]}]},
				// 'a=gt=b': 'gt(a,b)',
				// 'a>b': 'gt(a,b)'
			},
			'greater-than-equals': {
				'ge(a,b)': { name: 'and', args: [{ name: 'ge', args: [ 'a', 'b' ]}]},
				// 'a=ge=b': 'ge(a,b)',
				// 'a>=b': 'ge(a,b)'
			},
			'nested comparisons': {
				'a(b(le(c,d)))': { name: 'and', args: [
					{ name: 'a', args: [{ name: 'b', args: [{ name: 'le', args: [ 'c', 'd' ]}]}]}
				]},
				// 'a(b(c=le=d))': 'a(b(le(c,d)))',
				// 'a(b(c<=d))': 'a(b(le(c,d)))'
			},
			'arbitrary FIQL desugaring': {
				// 'a=b=c': { name: 'and', args: [{ name: 'b', args: [ 'a', 'c' ]}]},
				// 'a(b=cd=e)': { name: 'and', args: [{ name: 'a', args: [{ name: 'cd', args: [ 'b', 'e' ]}]}]}
			},
			'and grouping': {
				'a&b&c': { name: 'and', args: [ 'a', 'b', 'c' ]},
				'a(b)&c': { name: 'and', args: [ { name: 'a', args: [ 'b' ] }, 'c' ]},
				'a&(b&c)': { name: 'and', args: [ 'a', { name: 'and', args: [ 'b', 'c' ]}]}
			},
			'or grouping': {
				'(a|b|c)': { name: 'and', args: [{ name: 'or', args: [ 'a', 'b', 'c' ]}]},
				'(a(b)|c)': { name: 'and', args: [{ name: 'or', args: [ { name: 'a', args: [ 'b' ]}, 'c' ]}]}
			},
			'complex grouping': {
				'a&(b|c)': { name: 'and', args: [ 'a', { name: 'or', args: [ 'b', 'c' ]}]},
				'a|(b&c)': { name: 'or', args: [ 'a', { name: 'and', args: [ 'b', 'c' ]}]},
				// 'a(b(c<d,e(f=g)))': { 'name': 'and', 'args': [{ 'name': 'a', 'args': [{ 'name': 'b', 'args': [{ 'name': 'lt', 'args': ['c', 'd']}, {'name':'e', 'args': [{ 'name': 'eq', 'args': [ 'f', 'g' ]}]}]}]}]}
			},
			'complex comparisons': {

			},
			'string coercion': {
				'a(string)': { name: 'and', args: [{ name: 'a', args: [ 'string' ]}]},
				'a(string:b)': { name: 'and', args: [{ name: 'a', args: [ 'b' ]}]},
				'a(string:1)': { name: 'and', args: [{ name: 'a', args: [ '1' ]}]}
			},
			'number coercion': {
				'a(number)': { name: 'and', args: [{ name: 'a', args: [ 'number' ]}]},
				'a(number:1)': {name: 'and', args: [{ name: 'a', args: [ 1 ]}]}
				//'a(number:b)': { name: 'and', args: [{ name: 'a', args: [ NaN ]}]} // supposed to throw an error
			},
			'date coercion': {
				//FIXME do we need proper ISO date subset parsing?
				'a(date)': { name: 'and', args: [{ name: 'a', args: [ 'date' ]}]},
				'a(date:2009)': supportsDateString && { name: 'and', args: [{ name: 'a', args: [ new Date('2009') ]}]},
				'a(date:1989-11-21)': supportsDateString && {name: 'and', args:[{name: 'a', args: [(new Date('1989-11-21'))]}]},
				'a(date:1989-11-21T00:21:00.21Z)': {name: 'and', args:[{name: 'a', args: [(new Date(Date.UTC(1989, 10, 21, 0, 21, 0, 21)))]}]},
				'a(date:1989-11-21T00:21:00Z)': {name: 'and', args:[{name: 'a', args: [(new Date(Date.UTC(1989, 10, 21, 0, 21, 0)))]}]}
				//'a(date:b)': { name: 'and', args: [{ name: 'a', args: [ new Date(NaN) ]}]} // XXX?// supposed to throw an error
			},
			'boolean coercion': {
				'a(true)': { name: 'and', args: [{ name: 'a', args: [ true ]}]},
				'a(false)': { name: 'and', args: [{ name: 'a', args: [ false ]}]},
				'a(boolean:true)': { name: 'and', args: [{ name: 'a', args: [ true ]}]}
			},
			'null coercion': {
				'a(null)': { name: 'and', args: [{ name: 'a', args: [ null ]}]},
				'a(auto:null)': { name: 'and', args: [{ name: 'a', args: [ null ]}]},
				'a(string:null)': { name: 'and', args: [{ name: 'a', args: [ 'null' ]}]}
			},
			'complex coercion': {
				// '(a=b|c=d)&(e=f|g=1)': { name: 'and', args: [
				// 	{ name: 'or', args: [{ name: 'eq', args: [ 'a', 'b' ]}, { name: 'eq', args: [ 'c', 'd' ]}]},
				// 	{ name: 'or', args: [{ name: 'eq', args: [ 'e', 'f' ]}, { name: 'eq', args: [ 'g', 1 ]}]}
				// ]}
			}
		},
		testParsing = (function () {
			var tests = {},
				test,
				group,
				pairs,
				key;

			for (group in queryPairs) {
				tests[ group ] = test = {};
				pairs = queryPairs [ group ];
				for (key in pairs) {
					// Wrap the test function in another function call so
					// that the keys and pairs objects are correctly bound
					var f = function (k, p) {
						return function () {
							// skip tests which don't have an expected value
							if (!p[ k ]) {
								return this.skip();
							}

							var actual = parseQuery(k),
								expected = p[ k ];

							if (!hasKeys(actual.cache)) {
								delete actual.cache;
							}

							if (typeof expected === 'string') {
								expected = parseQuery(expected);
							}

							if (!hasKeys(expected.cache)) {
								delete expected.cache;
							}

							// someone decided that matching constructors is necessary for deep equality
							// see https://github.com/theintern/intern/issues/284
							// the deepEqual assertion also fails due to properties like toString so this assertion seems to
							// be the most suitable.
							assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
						};
					};
					test[ key ] = f(key, pairs);
				}
			}

			return tests;
		})();

	function hasKeys(it) {
		var key;

		if (it == null || typeof it !== 'object') {
			return false;
		}

		for (key in it) {
			if (it.hasOwnProperty(key)) {
				return true;
			}
		}
		return false;
	}

	test({
		name: 'rql/test/query',

		testBehavior: function () {
			//assert.error(parseQuery(), "parseQuery requires a string");
			assert.ok(parseQuery('') instanceof Query, 'should inherit from Query');
			// assert.ok(parseQuery('a=b') instanceof Query, 'should inherit from Query');
			//assert.error(parseQuery('?a=b'), 'cannot begin with a ?');
		},

		testParsing: testParsing,

		testBindParameters: function () {
			// TODO
			var parsed;
			parsed = parseQuery('in(id,$1)', [['a','b','c']]);
			assert.strictEqual(JSON.stringify(parsed), JSON.stringify({
				name: 'and',
				args: [{ name: 'in', args: [ 'id', [ 'a', 'b', 'c' ]]}],
				cache: {}
			}));
			parsed = parseQuery('eq(id,$1)', [ 'a' ]);
			assert.deepEqual(JSON.stringify(parsed), JSON.stringify({
				name: 'and',
				args: [{ name: 'eq', args: ['id', 'a']}],
				cache: {id: 'a'}
			}));
		},

		testStringification: function () {
			// TODO
			var parsed;
			parsed = parseQuery('eq(id1,RE:%5Eabc%5C%2F)');
			// Hmmm. deepEqual gives null for regexps?
			assert.ok(parsed.args[0].args[1].toString() === /^abc\//.toString());
			//assert.deepEqual(parsed, {name: 'and', args: [{name: 'eq', args: ['id1', /^abc\//]}]});
			assert.ok(new Query().eq('_1',/GGG(EE|FF)/i) + '' === 'eq(_1,re:GGG%28EE%7CFF%29)');
			parsed = parseQuery('eq(_1,re:GGG%28EE%7CFF%29)');
			console.log(parsed.args[0].args[1].toString() === /GGG(EE|FF)/i.toString());
			//assert.ok(Query().eq('_1',/GGG(EE|FF)/)+'' === 'eq(_1,RE:GGG%28EE%7CFF%29)');
			// string to array and back
			var str = 'somefunc(and(1),(a,b),(10,(10,1)),(a,b.c))';
			assert.equal(parseQuery(str) + '', str);
			// quirky arguments
			var name = ['a/b','c.d'];
			assert.equal(parseQuery(new Query().eq(name,1) + '') + '', 'eq((a%2Fb,c.d),1)');
			assert.deepEqual(parseQuery(new Query().eq(name,1) + '').args[0].args[0], name);
		},

		testMatches: function () {
			var query = new Query().match('name', /Will*/);
			assert.equal('' + query, 'match(name,RE:Will*)');
		}
	});
});
