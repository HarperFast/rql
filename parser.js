// Copyright (c) 2012-2015, Parallels Inc. All rights reserved.
// Available via the modified BSD license. See LICENSE for details.
/**
 * This module provides RQL parsing. For example:
 * var parsed = require("./parser").parse("b=3&le(c,5)");
 */
function exportFactory(exports, contains) {

	var operatorMap = {
		"=": "eq",
		"==": "eq",
		">": "gt",
		">=": "ge",
		"<": "lt",
		"<=": "le",
		"!=": "ne"
	};

	var denialMap = {
		"eq": "ne",
		"ne": "eq",
		"gt": "le",
		"ge": "lt",
		"lt": "ge",
		"le": "gt",
		"and": "or",
		"or": "and",
		"in": "out",
		"out": "in",
		"not": "not",
		"like": "_like"
	};

	exports.primaryKeyName = "id";
	exports.lastSeen = ["sort", "select", "values", "limit"];
	exports.jsonQueryCompatible = true;

	function parse(/*String|Object*/query, parameters){
		if (typeof query === "undefined" || query === null)
			query = "";
		var term = new exports.Query();
		var topTerm = term;
		var not = false;
		topTerm.cache = {}; // room for lastSeen params
		if(typeof query === "object"){
			if(query instanceof exports.Query){
				return query;
			}
			for(var i in query){
				term = new exports.Query();
				topTerm.args.push(term);
				term.name = "eq";
				term.args = [i, query[i]];
			}
			return topTerm;
		}
		if(query.charAt(0) == "?"){
			throw new URIError("Query must not start with ?");
		}
		if(exports.jsonQueryCompatible){
			query = query.replace(/%3C=/g,"=le=").replace(/%3E=/g,"=ge=").replace(/%3C/g,"=lt=").replace(/%3E/g,"=gt=");
		}
		if(query.indexOf("/") > -1){ // performance guard
			// convert slash delimited text to arrays
			query = query.replace(/[\+\*\$\-:\w%\._]*\/[\+\*\$\-:\w%\._\/]*/g, function(slashed){
				return "(" + slashed.replace(/\//g, ",") + ")";
			});
		}
		// convert FIQL to normalized call syntax form
		query = query.replace(/(\([\+\*\$\-:\w%\._,]+\)|[\+\*\$\-:\w%\._]*|)([<>!]?=(?:[\w]*=)?|>|<)(\([\+\*\$\-:\w%\._,]+(\(\))*\)|[\+\*\$\-:\w%\._]*(\(\))*|)/g,
							 //<---------       property        -----------><------  operator -----><----------------   value ------------------>
				function(t, property, operator, value){
			if(operator.length < 3){
				if(!operatorMap[operator]){
					throw new URIError("Illegal operator " + operator);
				}
				operator = operatorMap[operator];
			}
			else{
				operator = operator.substring(1, operator.length - 1);
			}
			return operator + "(" + property + "," + value + ")";
		});
		if(query.charAt(0)=="?"){
			query = query.substring(1);
		}
		var leftoverCharacters = query.replace(/(\))|([&\|,;])?([\+\*\$\-:\w%\._]*)(\(?)/g,
							   //    <-closedParan->|<-delim-- propertyOrValue -----(> |
			function(t, closedParan, delim, propertyOrValue, openParan){
				if(delim){
					if(delim === "&"){
						setConjunction("and");
					}
					if(delim === "|" || delim === ";"){
						setConjunction("or");
					}
				}
				if(openParan){
					var newTerm = new exports.Query();
					newTerm.name = not ? denialMap[propertyOrValue] : propertyOrValue;
					newTerm.parent = term;
					if(propertyOrValue === "not")
						not = !not;

					call(newTerm);
				}
				else if(closedParan){
					var isArray = !term.name;
					if(term.name === "not") not = !not;
					term = term.parent;
					if(!term){
						throw new URIError("Closing paranthesis without an opening paranthesis");
					}
					if(isArray){
						term.args.push(term.args.pop().args);
					}
				}
				else if(propertyOrValue || delim === ","){
					term.args.push(stringToValue(propertyOrValue, parameters));

					// cache the last seen sort(), select(), values() and limit()
					if (exports.lastSeen.indexOf(term.name) >= 0) {
						topTerm.cache[term.name] = term.args;
					}
					// cache the last seen id equality
					if (term.name === "eq" && term.args[0] === exports.primaryKeyName) {
						var id = term.args[1];
						if (id && !(id instanceof RegExp)) id = id.toString();
						topTerm.cache[exports.primaryKeyName] = id;
					}
				}
				return "";
			});
		if(term.parent){
			throw new URIError("Opening paranthesis without a closing paranthesis");
		}
		if(leftoverCharacters){
			// any extra characters left over from the replace indicates invalid syntax
			throw new URIError("Illegal character in query string encountered " + leftoverCharacters);
		}

		function call(newTerm){
			term.args.push(newTerm);
			term = newTerm;
			// cache the last seen sort(), select(), values() and limit()
			if (exports.lastSeen.indexOf(term.name) >= 0) {
				topTerm.cache[term.name] = term.args;
			}
		}
		function setConjunction(operator){
			if(!term.name){
				term.name = not ? denialMap[operator] : operator;
			}
			else if(term.name !== operator){
				throw new Error("Can not mix conjunctions within a group, use paranthesis around each set of same conjuctions (& and |)");
			}
		}
		function removeParentProperty(obj) {
			if(obj && obj.args){
				delete obj.parent;
				obj.args.forEach(removeParentProperty);
			}
			return obj;
		}
		removeParentProperty(topTerm);
		return topTerm;
	}

	exports.parse = exports.parseQuery = parse;

	/* dumps undesirable exceptions to Query().error */
	exports.parseGently = function(){
		var terms;
		try {
			terms = parse.apply(this, arguments);
		} catch(err) {
			terms = new exports.Query();
			terms.error = err.message;
		}
		return terms;
	};

	exports.commonOperatorMap = {
		"and" : "&",
		"or" : "|",
		"eq" : "=",
		"ne" : "!=",
		"le" : "<=",
		"ge" : ">=",
		"lt" : "<",
		"gt" : ">"
	};
	function stringToValue(string, parameters){
		var converter = exports.converters["default"];
		if(string.charAt(0) === "$"){
			var param_index = parseInt(string.substring(1), 10) - 1;
			return param_index >= 0 && parameters ? parameters[param_index] : undefined;
		}
		if(string.indexOf(":") > -1){
			var parts = string.split(":");
			if(parts.length == 2) {
				converter = exports.converters[parts[0]];
				string = parts[1];
			}
			if(!converter){
				throw new URIError("Unknown converter " + parts[0]);
			}
		}
		if(/^\d{4}-[0-1]\d-[0-3][0-9](T([0-2]\d:){2}[0-2]\d([-+][0-2]\d:[0-2]\d)*)*$/.test(string))
			converter = exports.converters["date"];

		return converter(string);
	}

	var autoConverted = exports.autoConverted = {
		"undefined": undefined,
		"Infinity": Infinity,
		"-Infinity": -Infinity
	};

	exports.converters = {
		auto: function(string){
			if(autoConverted.hasOwnProperty(string)){
				return autoConverted[string];
			}
			var number = +string;
			if(isNaN(number) || number.toString() !== string){
				string = decodeURIComponent(string);
				if(exports.jsonQueryCompatible){
					if(string.charAt(0) == "'" && string.charAt(string.length-1) == "'"){
						return JSON.parse('"' + string.substring(1,string.length-1) + '"');
					}
				}
				return string;
			}
			return number;
		},
		date: function(x){
			var isoDate = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(x);
			var date;
			if (isoDate) {
				date = new Date(Date.UTC(+isoDate[1], +isoDate[2] - 1, +isoDate[3], +isoDate[4], +isoDate[5], +isoDate[6], +isoDate[7] || 0));
			}else{
				date = new Date(x);
			}
			if (isNaN(date.getTime())){
				throw new URIError("Invalid date " + x);
			}
			return date;
		}
	};

	exports.converters["default"] = exports.converters.auto;

	// this can get replaced by the chainable query if query.js is loaded
	exports.Query = function(){
		this.name = "and";
		this.args = [];
	};
	return exports;
}

if(typeof define!="undefined") {
  define(['exports', './util/contains'], function(exports, contains) {
    return exportFactory(exports, contains);
  });
}else {
  exportFactory(
    module.exports,
    require("./util/contains"));
}

