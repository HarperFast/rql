/**
 * This module provides RQL parsing. For example:
 * var parsed = require("./parser").parse("b=3&le(c,5)");
 */
({define:typeof define!="undefined"?define:function(deps, factory){module.exports = factory(exports);}}).
define(["exports"], function(){

var operatorMap = {
	"=": "eq",
	"==": "eq",
	">": "gt",
	">=": "ge",
	"<": "lt",
	"<=": "le",
	"!=": "ne"
};

function parse(/*String|Object*/query, parameters){
	if (typeof query === "undefined" || query === null) query = '';
	var term = new Query();
	var topTerm = term;
	if (typeof query === "object") {
		if (Array.isArray(query)){
			query = topTerm.in('id', query);
		} else if (!(query instanceof Query)) {
			for(var i in query){
				var term = new Query();
				topTerm.args.push(term);
				term.name = "eq";
				term.args = [i, query[i]];
			}
			query = topTerm;
		}
		return query;
	}
	if (query.charAt(0) == "?") query = query.substring(1);
	if (query.indexOf("/") >= 0) { // performance guard
		// convert slash delimited text to arrays
		query = query.replace(/[\+\*\$\-:\w%\._]*\/[\+\*\$\-:\w%\._\/]*/g, function(slashed){
			return "(" + slashed.replace(/\//g, ",") + ")";
		});
	}
	// convert FIQL to normalized call syntax form
	query = query.replace(/(\([\+\*\$\-:\w%\._,]+\)|[\+\*\$\-:\w%\._]*|)([<>!]?=(?:[\w]*=)?|>|<)(\([\+\*\$\-:\w%\._,]+\)|[\+\*\$\-:\w%\._]*|)/g,
						 //<---------       property        -----------><------  operator -----><----------------   value ------------------>
		function(t, property, operator, value){
			if (operator.length < 3) {
				if (!operatorMap[operator]) {
					throw new URIError("Illegal operator " + operator);
				}
				operator = operatorMap[operator];
			} else {
				operator = operator.substring(1, operator.length - 1);
			}
			return operator + "(" + property + "," + value + ")";
		}
	);
	if (query.charAt(0) == "?") query = query.substring(1);
	var leftoverCharacters = query.replace(/(\))|([&\|,])?([\+\*\$\-:\w%\._]*)(\(?)/g,
								//<-closedParen->|<-delim-- propertyOrValue -----(> |
		function(t, closedParen, delim, propertyOrValue, openParen){
			if (delim) {
				if (delim === "&") {
					setConjunction("and");
				} else if (delim === "|") {
					setConjunction("or");
				}
			}
			if (openParen) {
				var newTerm = new Query();
				newTerm.name = propertyOrValue;
				newTerm.parent = term;
				call(newTerm);
			} else if (closedParen) {
				var isArray = !term.name;
				term = term.parent;
				if (!term) {
					throw new URIError("Closing parenthesis without an opening parenthesis");
				}
				if (isArray) {
					term.args.push(term.args.pop().args);
				}
			} else if (propertyOrValue || delim === ",") {
				term.args.push(stringToValue(propertyOrValue, parameters));
			}
			return "";
		}
	);
	if (term.parent) {
		throw new URIError("Opening parenthesis without a closing parenthesis");
	}
	if (leftoverCharacters) {
		// any extra characters left over from the replace indicates invalid syntax
		throw new URIError("Illegal character in query string encountered " + leftoverCharacters);
	}

	function call(newTerm){
		term.args.push(newTerm);
		term = newTerm;
	}
	function setConjunction(operator){
		if (!term.name) {
			term.name = operator;
		} else if (term.name !== operator) {
			throw new Error("Can not mix conjunctions within a group, use parenthesis around each set of same conjuctions (& and |)");
		}
	}
	function removeParentProperty(obj) {
		if (obj && obj.args) {
			delete obj.parent;
			if (obj.args.forEach) {
				obj.args.forEach(removeParentProperty);
			} else {
				for (var fe = 0; fe < obj.args.length; fe += 1)
					removeParentProperty(obj.args[fe]);
			}
		}
		return obj;
	};
	removeParentProperty(topTerm);
	return topTerm;
};

/* dumps undesirable exceptions to Query().error */
function parseGently(){
	var terms;
	try {
		terms = parse.apply(this, arguments);
	} catch(err) {
		terms = new Query();
		terms.error = err.message;
	}
	return terms;
}

function stringToValue(string, parameters){
	var converter = converters['default'];
	if (string.charAt(0) === "$") {
		var param_index = parseInt(string.substring(1)) - 1;
		return param_index >= 0 && parameters ? parameters[param_index] : undefined;
	}
	if (string.indexOf(":") > -1) {
		var parts = string.split(":",2);
		converter = converters[parts[0]];
		if (!converter) throw new URIError("Unknown converter " + parts[0]);
		string = parts[1];
	}
	return converter(string);
};

var autoConverted = {
	"true": true,
	"false": false,
	"null": null,
	"undefined": undefined,
	"Infinity": Infinity,
	"-Infinity": -Infinity
};

var converters = {
	auto: function(string){
		if (autoConverted.hasOwnProperty(string)) {
			return autoConverted[string];
		}
		var number = +string;
		if(isNaN(number) || number.toString() !== string){
/*			var isoDate = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z$/.exec(date);
			if (isoDate) {
				return new Date(Date.UTC(+isoDate[1], +isoDate[2] - 1, +isoDate[3], +isoDate[4], +isoDate[5], +isoDate[6]));
			}*/
			string = decodeURIComponent(string);
			return string;
		}
		return number;
	},
	number: function(x){
		var number = +x;
		if (isNaN(number)) throw new URIError("Invalid number " + number);
		return number;
	},
	epoch: function(x){
		var date = new Date(+x);
		if (isNaN(date.getTime())) throw new URIError("Invalid date " + x);
		return date;
	},
	isodate: function(x){
		// four-digit year
		var date = '0000'.substr(0,4-x.length)+x;
		// pattern for partial dates
		date += '0000-01-01T00:00:00Z'.substring(date.length);
		return converters.date(date);
	},
	date: function(x){
		var date;
		var isoDate = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z$/.exec(x);
		if (isoDate) {
			date = new Date(Date.UTC(+isoDate[1], +isoDate[2] - 1, +isoDate[3], +isoDate[4], +isoDate[5], +isoDate[6]));
		} else {
			date = new Date(x);
		}
		if (isNaN(date.getTime())) throw new URIError("Invalid date " + x);
		return date;

	},
	"boolean": function(x){
		return x === "true";
	},
	string: function(string){
		return decodeURIComponent(string);
	},
	re: function(x){
		return new RegExp(decodeURIComponent(x), 'i');
	},
	RE: function(x){
		return new RegExp(decodeURIComponent(x));
	},
	glob: function(x){
		var s = decodeURIComponent(x).replace(/([\\|\||\(|\)|\[|\{|\^|\$|\*|\+|\?|\.|\<|\>])/g, function(x){return '\\'+x;}).replace(/\\\*/g,'.*').replace(/\\\?/g,'.?');
		if (s.substring(0,2) !== '.*') s = '^'+s; else s = s.substring(2);
		if (s.substring(s.length-2) !== '.*') s = s+'$'; else s = s.substring(0, s.length-2);
		return new RegExp(s, 'i');
	}
};

// FIXME: override
converters["default"] = converters.auto;

///////////////////////////////////////////////////////////////////////

/** Provides a Query constructor with chainable capability.
 */

function Query(seed, params){
	if (typeof seed === 'string') {
		return parse(seed, params);
	}
	this.name = "and";
	this.args = [];
	if (seed && seed.name && seed.args) {
		this.name = seed.name;
		this.args = seed.args;
	}
};

//TODO:THE RIGHT WAY IS:knownOperators = Object.keys(jsarray.operators || {}).concat(Object.keys(jsarray.jsOperatorMap || {}));
var knownOperators = ["sort", "match", "in", "out", "contains", "excludes", "all", "or", "and", "select", "values", "limit", "distinct", "recurse", "aggregate", "between", "sum", "mean", "max", "min", "count", "first", "one", "eq", "ne", "le", "ge", "lt", "gt"];
var knownScalarOperators = ["mean", "sum", "min", "max", "count", "first", "one"];
var arrayMethods = ["forEach", "reduce", "map", "filter", "indexOf", "some", "every"];

Query.prototype.toString = function(){
	return this.name === "and" ?
		this.args.map(queryToString).join("&") :
		queryToString(this);
};

Query.prototype.where = function(query){
	this.args = this.args.concat(parse(query).args);
	return this;
}

function queryToString(part) {
	if (Array.isArray(part)) {
		return "("+part.map(function(arg) {
			return queryToString(arg);
		}).join(",")+")";
	}
	if (part && part.name && part.args) {
		return [
				part.name,
				"(",
				part.args.map(function(arg) {
					return queryToString(arg);
				}).join(","),
				")"
		].join("");
	}
	return encodeValue(part);
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

function encodeValue(val) {
	var encoded;
	if (val === null) val = "null";
	if (typeof val === "undefined") return val;
	if (val !== converters["default"]("" + (
			val.toISOString && val.toISOString() || val.toString()
		))) {
		var type = typeof val;
		if (val instanceof RegExp) {
			// TODO: control whether to we want simpler glob() style
			val = val.toString();
			var i = val.lastIndexOf('/');
			type = val.substring(i).indexOf('i') >= 0 ? "re" : "RE";
			val = encodeString(val.substring(1, i));
			encoded = true;
		}
		if (val instanceof Date) {
			type = "epoch";
			val = val.getTime();
			encoded = true;
		}
		if (type === "string") {
			val = encodeString(val);
			encoded = true;
		}
		val = [type, val].join(":");
	}
	if (!encoded && typeof val === "string") val = encodeString(val);
	return val;
}

// FIXME: forEach requires ES5 shim!
/*(function updateQueryMethods(){
	knownOperators.forEach(function(name){
		Query.prototype[name] = function(){
			var newQuery = new Query();
			newQuery.executor = this.executor;
			var newTerm = new Query(name);
			newTerm.args = Array.prototype.slice.call(arguments);
			newQuery.args = this.args.concat([newTerm]);
			return newQuery;
		};
	});
	knownScalarOperators.forEach(function(name){
		Query.prototype[name] = function(){
			var newQuery = new Query();
			newQuery.executor = this.executor;
			var newTerm = new Query(name);
			newTerm.args = Array.prototype.slice.call(arguments);
			newQuery.args = this.args.concat([newTerm]);
			return newQuery.executor(newQuery);
		};
	});
	arrayMethods.forEach(function(name){
		Query.prototype[name] = function(){
			var args = arguments;
			return when(this.executor(this), function(results){
				return results[name].apply(results, args);
			});
		};
	});
})();*/

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

///////////////////////////////////////////////////////////////////////

return {
	Query: Query,
	parse: parse,
	parseGently: parseGently
};

});
