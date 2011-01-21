/**
 * Provides a Query constructor with chainable capability. For example:
 * var Query = require("./query").Query;
 * query = Query();
 * query.executor = function(query){
 *		require("./js-array").query(query, params, data); // if we want to operate on an array
 * };
 * query.eq("a", 3).le("b", 4).forEach(function(object){
 *	 // for each object that matches the query
 * });
 */
//({define:typeof define!="undefined"?define:function(deps, factory){module.exports = factory(exports, require("./parser"), require("./js-array"));}}).
//define(["exports", "./parser", "./js-array"], function(exports, parser, jsarray){
({define:typeof define!="undefined"?define:function(deps, factory){module.exports = factory(exports, require("./parser"));}}).
define(["exports", "./parser"], function(exports, parser){

var parseQuery = parser.parseQuery;
try{
	var when = require("promised-io/promise").when;
}catch(e){
	when = function(value, callback){callback(value)};
}

parser.Query = function(seed, params){
	if (typeof seed === 'string')
		return parseQuery(seed, params);
	var q = new Query();
	if (seed && seed.name && seed.args)
		q.name = seed.name, q.args = seed.args;
	return q;
};
exports.Query = parser.Query;
//TODO:THE RIGHT WAY IS:exports.knownOperators = Object.keys(jsarray.operators || {}).concat(Object.keys(jsarray.jsOperatorMap || {}));
exports.knownOperators = ["sort", "match", "in", "out", "contains", "excludes", "all", "or", "and", "select", "values", "limit", "distinct", "recurse", "aggregate", "between", "sum", "mean", "max", "min", "count", "first", "one", "eq", "ne", "le", "ge", "lt", "gt"];
exports.knownScalarOperators = ["mean", "sum", "min", "max", "count", "first", "one"];
exports.arrayMethods = ["forEach", "reduce", "map", "filter", "indexOf", "some", "every"];

function Query(name){
	this.name = name || "and";
	this.args = [];
}
exports.Query.prototype = Query.prototype;
Query.prototype.toString = function(){
	return this.name === "and" ?
		this.args.map(queryToString).join("&") :
		queryToString(this);
};

Query.prototype.where = function(query){
	this.args = this.args.concat(parseQuery(query).args);
	return this;
}

function queryToString(part) {
		if (part instanceof Array) {
				return '('+part.map(function(arg) {
						return queryToString(arg);
				}).join(",")+')';
		}
		if (part && part.name && part.args) {
				return [
						part.name,
						"(",
						part.args.map(function(arg, pos) {
								return queryToString(arg);
						}).join(","),
						")"
				].join("");
		}
		return exports.encodeValue(part);
};

function encodeString(s) {
		if (typeof s === "string") {
				s = encodeURIComponent(s);
				if (s.match(/[\(\)]/)) {
						s = s.replace("(","%28").replace(")","%29");
				};
		}
		return s;
}

exports.encodeValue = function(val) {
		var encoded;
		if (val === null) val = 'null';
		if (typeof val === 'undefined') return val;
		if (val !== parser.converters["default"]('' + (
				val.toISOString && val.toISOString() || val.toString()
		))) {
				var type = typeof val;
				if(val instanceof RegExp){
					// TODO: control whether to we want simpler glob() style
					val = val.toString();
					var i = val.lastIndexOf('/');
					type = val.substring(i).indexOf('i') >= 0 ? "re" : "RE";
					val = encodeString(val.substring(1, i));
					encoded = true;
				}
				if(val instanceof Date){
						type = "epoch";
						val = val.getTime();
						encoded = true;
				}
				if(type === "string") {
						val = encodeString(val);
						encoded = true;
				}
				val = [type, val].join(":");
		}
		if (!encoded && typeof val === "string") val = encodeString(val);
		return val;
};

exports.updateQueryMethods = function(){
	exports.knownOperators.forEach(function(name){
		Query.prototype[name] = function(){
			var newQuery = new Query();
			newQuery.executor = this.executor;
			var newTerm = new Query(name);
			newTerm.args = Array.prototype.slice.call(arguments);
			newQuery.args = this.args.concat([newTerm]);
			return newQuery;
		};
	});
	exports.knownScalarOperators.forEach(function(name){
		Query.prototype[name] = function(){
			var newQuery = new Query();
			newQuery.executor = this.executor;
			var newTerm = new Query(name);
			newTerm.args = Array.prototype.slice.call(arguments);
			newQuery.args = this.args.concat([newTerm]);
			return newQuery.executor(newQuery);
		};
	});
	exports.arrayMethods.forEach(function(name){
		Query.prototype[name] = function(){
			var args = arguments;
			return when(this.executor(this), function(results){
				return results[name].apply(results, args);
			});
		};
	});

};

exports.updateQueryMethods();

/* recursively iterate over query terms calling 'fn' for each term */
Query.prototype.walk = function(fn, options){
	options = options || {};
	function walk(){
		var self = this;
		this.args = this.args.map(function(term, i, arr) {
			var args, func, key, x;
			term != null ? term : term = {};
			func = term.name;
			args = term.args;
			if (!func || !args) {
				return;
			}
			var f;
			if (args[0] instanceof Query) {
				f = walk;
			} else {
				f = fn;
			}
			return f.call(term);
		}).filter(function(x){return x;});
		return this;
	}
	var q = walk.call(this);
	return q;
};

/* disambiguate query */
Query.prototype.normalize = function(options){
	options = options || {};
	options.primaryKey = options.primaryKey || 'id';
	options.clear = options.clear || [];
	options.map = options.map || {};
	var result = {
		search: this,
		last: {},
		sort: [],
		sortObj: {},
		sortArr: [],
		limit: [Infinity, 0],
		select: [],
		selectObj: {},
		selectArr: [],
		values: false
	};
	var plusMinus = {
		// [plus, minus]
		sort: [1, -1],
		select: [1, 0]
	};
	function normal(){
		var func = this.name;
		var args = this.args;
		if (!func || !args) return;
		// rename props
		args = this.args = args.map(function(x){return x === 'id' || x === '-id' || x === '+id' ? x.replace('id', options.primaryKey) : x});
		//console.log('MAPPED', args);
		// cache some parameters
		if (func === 'sort' || func === 'select' || func === 'values') {
			if (func === 'values') {
				func = 'select';
				result.values = true;
			}
			result[func] = args;
			var pm = plusMinus[func];
			result[func+'Obj'] = {};
			result[func+'Arr'] = result[func].map(function(x, index){
				if (x instanceof Array) x = x.join('.');
				var a = /([-+]*)(.+)/.exec(x);
				var v = pm[(a[1].charAt(0) === '-')*1] * (index+1);
				result[func+'Obj'][a[2]] = v;
				return {name: a[2], value: v};
			});
		} else if (func === 'limit') {
			// validate limit() args to be numbers, with sane defaults
			var limit = args;
			var skip = +limit[1] || 0;
			limit = +limit[0] || Infinity;
			if (options.hardLimit && limit > options.hardLimit)
				limit = options.hardLimit;
			result.limit = [limit, skip];
			result.needCount = true;
		} else {
			if (func === 'eq') {
				// cache first primary key equality -- useful to distinguish between .get(id) and .query(query)
				if (args[0] === options.primaryKey && ['string','number'].indexOf(typeof args[1]) >= 0) {
					if (!result.pk)
						result.pk = String(args[1]);
				}
			}
			// collect search conditions
			var arg0 = args[0];
			if (arg0 instanceof Array) arg0 = arg0.join('/');
			//if (!result.cond[arg0])
			//	result.cond[arg0] = [];
			//result.cond[arg0].push(this);
			// memorize the last condition
			result.last[arg0] = this;
			// clear all conditions on fields specified in options.clear[]
			return options.clear.indexOf(this.args[0]) >= 0 ? undefined : this;
		}
		// cache search conditions
		//if (options.known[func])
		// map some functions
		/*if (options.map[func]) {
			func = options.map[func];
		}*/
	}

	// normalize
	this.walk(normal);

	result.filter = function(query){
		var Q = String(query);
		//console.log('ADD', Q, this.search);
		this.search.args = this.search.args.filter(function(x){
			return String(x) !== Q;
		});
		/*var args = query.args[0].args;
		var arg0 = args[0];
		if (arg0 instanceof Array) arg0 = arg0.join('/');
		if (!this.cond[arg0])
			this.cond[arg0] = [];
		this.cond[arg0].push(query.args[0]);*/
		this.search.args.push(query.args[0]);
		return this;
	};

	result.toString = function(){
		var q = this.search;
		['sort', 'select', 'limit', 'values'].forEach(function(op){
			var args = result[op];
			if (args instanceof Array && args.length)
				q = q[op].apply(q, args);
		});
		return q.toString();
	};

	return result;
};

/* FIXME: an example will be welcome
Query.prototype.toMongo = function(options){
	return this.normalize({
		primaryKey: '_id',
		map: {
			ge: 'gte',
			le: 'lte'
		},
		known: ['lt','lte','gt','gte','ne','in','nin','not','mod','all','size','exists','type','elemMatch']
	});
};
*/

return exports;
});
