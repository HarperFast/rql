// Copyright (c) 2012-2015, Parallels Inc. All rights reserved.
// Available via the modified BSD license. See LICENSE for details.
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
function exportFactory(exports, parser, each) {

	var parseQuery = parser.parseQuery, when;
	try {
		when = require("promised-io/promise").when;
	} catch(e){
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
	exports.knownOperators = ["like", "sort", "match", "in", "out", "or", "and", "select", "contains", "excludes", "values", "limit", "distinct", "recurse", "aggregate", "between", "sum", "mean", "max", "min", "count", "first", "one", "eq", "ne", "le", "ge", "lt", "gt"];
	exports.knownScalarOperators = ["mean", "sum", "min", "max", "count", "first", "one"];
	exports.arrayMethods = ["forEach", "reduce", "map", "filter", "indexOf", "some", "every"];

	function Query(name){
		this.name = name || "and";
		this.args = [];
	}
	function serializeArgs(array, delimiter){
		var results = [];
		for(var i = 0, l = array.length; i < l; i++){
			results.push(queryToString(array[i]));
		}
		return results.join(delimiter);
	}
	exports.Query.prototype = Query.prototype;
	Query.prototype.toString = function(){
		return this.name === "and" ?
			serializeArgs(this.args, "&") :
			queryToString(this);
	};

	function queryToString(part) {
			if (part instanceof Array) {
					return '(' + serializeArgs(part, ",")+')';
			}
			if (part && part.name && part.args) {
					return [
							part.name,
							"(",
							serializeArgs(part.args, ","),
							")"
					].join("");
			}
			return exports.encodeValue(part);
	}

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
					if(type === "object"){
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
		each(exports.knownOperators, function(name){
			Query.prototype[name] = function(){
				var newQuery = new Query();
				newQuery.executor = this.executor;
				var newTerm = new Query(name);
				newTerm.args = Array.prototype.slice.call(arguments);
				newQuery.args = this.args.concat([newTerm]);
				return newQuery;
			};
		});
		each(exports.knownScalarOperators, function(name){
			Query.prototype[name] = function(){
				var newQuery = new Query();
				newQuery.executor = this.executor;
				var newTerm = new Query(name);
				newTerm.args = Array.prototype.slice.call(arguments);
				newQuery.args = this.args.concat([newTerm]);
				return newQuery.executor(newQuery);
			};
		});
		each(exports.arrayMethods, function(name){
			// this makes no guarantee of ensuring that results supports these methods
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
		function walk(name, terms){
			terms = terms || [];

			var i = 0,
				l = terms.length,
				term,
				args,
				func,
				newTerm;

			for (; i < l; i++) {
				term = terms[i];
				if (term == null) {
					term = {};
				}
				func = term.name;
				args = term.args;
				if (!func || !args) {
					continue;
				}
				if (args[0] instanceof Query) {
					walk.call(this, func, args);
				}
				else {
					newTerm = fn.call(this, func, args);
					if (newTerm && newTerm.name && newTerm.ags) {
						terms[i] = newTerm;
					}
				}
			}
		}
		walk.call(this, this.name, this.args);
	};

	/* append a new term */
	Query.prototype.push = function(term){
		this.args.push(term);
		return this;
	};

	/* disambiguate query */
	Query.prototype.normalize = function(options){
		options = options || {};
		options.primaryKey = options.primaryKey || 'id';
		options.map = options.map || {};
		var result = {
			original: this,
			sort: [],
			limit: [Infinity, 0, Infinity],
			skip: 0,
			limit: Infinity,
			select: [],
			values: false
		};
		var plusMinus = {
			// [plus, minus]
			sort: [1, -1],
			select: [1, 0]
		};
		function normal(func, args){
			// cache some parameters
			if (func === 'sort' || func === 'select') {
				result[func] = args;
				var pm = plusMinus[func];
				result[func+'Arr'] = result[func].map(function(x){
					if (x instanceof Array) x = x.join('.');
					var o = {};
					var a = /([-+]*)(.+)/.exec(x);
					o[a[2]] = pm[(a[1].charAt(0) === '-')*1];
					return o;
				});
				result[func+'Obj'] = {};
				result[func].forEach(function(x){
					if (x instanceof Array) x = x.join('.');
					var a = /([-+]*)(.+)/.exec(x);
					result[func+'Obj'][a[2]] = pm[(a[1].charAt(0) === '-')*1];
				});
			} else if (func === 'limit') {
				// validate limit() args to be numbers, with sane defaults
				var limit = args;
				result.skip = +limit[1] || 0;
				limit = +limit[0] || 0;
				if (options.hardLimit && limit > options.hardLimit)
					limit = options.hardLimit;
				result.limit = limit;
				result.needCount = true;
			} else if (func === 'values') {
				// N.B. values() just signals we want array of what we select()
				result.values = true;
			} else if (func === 'eq') {
				// cache primary key equality -- useful to distinguish between .get(id) and .query(query)
				var t = typeof args[1];
				//if ((args[0] instanceof Array ? args[0][args[0].length-1] : args[0]) === options.primaryKey && ['string','number'].indexOf(t) >= 0) {
				if (args[0] === options.primaryKey && ('string' === t || 'number' === t)) {
					result.pk = String(args[1]);
				}
			}
			// cache search conditions
			//if (options.known[func])
			// map some functions
			/*if (options.map[func]) {
				func = options.map[func];
			}*/
		}
		this.walk(normal);
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
}

if(typeof define!="undefined") {
  define(['exports', './parser', './util/each'], function(exports, parser, each) {
    return exportFactory(exports, parser, each);
  });
}else {
  exportFactory(
    module.exports,
    require("./parser"),
    require("./util/each"));
}

