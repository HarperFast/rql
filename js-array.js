// Copyright (c) 2012-2015, Parallels Inc. All rights reserved.
// Available via the modified BSD license. See LICENSE for details.
/*
 * An implementation of RQL for JavaScript arrays. For example:
 * require("./js-array").query("a=3", {}, [{a:1},{a:3}]) -> [{a:3}]
 */
  function exportFactory(exports, parser, QUERY, each, contains) {

	var parseQuery = parser.parse,
		stringify = JSON.stringify;

	function escape(s){
		return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
	}

	function likeToString(param){
		if(!param) return "false;";

		var start	 = param[0] == "*",
			end		 = param[param.length-1] == "*";

		if(start)	param = param.slice(1);
		if(end)		param = param.slice(0, param.length-1);

		var stars = param.split("*");
		if(stars.length > 1){
			for(var i=0; i<stars.length; i++)
				stars[i] = escape(decodeURIComponent(stars[i]));
			param = stars.join(".*");
		}

		if(start||end||stars.length>1)
			param = new RegExp((start ? "" : "^") + param + (end ? "" : "$"), "i");

		if(param && param.test)
			return param + ".test(value);";
		else
			return "\"" + decodeURIComponent(param).toUpperCase() + "\"===value.toUpperCase();";
	}

	function filter(condition, not){
		var filt = function(property, second){
			if(typeof second == "undefined"){
				second = property;
				property = undefined;
			}
			var args = arguments;
			var filtered = [];
			for(var i = 0, length = this.length; i < length; i++){
				var item = this[i];
				if(condition(evaluateProperty(item, property), second))
					filtered.push(item);
			}
			return filtered;
		};
		filt.condition = condition;
		return filt;
	}

	function contains(array, item){
		for(var i = 0, l = array.length; i < l; i++){
			if(array[i] === item) return true;
		}
	}

	function evaluateProperty(object, property){
		if(property.indexOf(".") != -1){
			property = property.split(".");
			property.forEach(function(part){
				object = object[decodeURIComponent(part)];
			});
			return object;
		}else if(typeof property == "undefined"){
			return object;
		}else{
			return object[decodeURIComponent(property)];
		}
	}

	function query(quer, options, target){
		options = options || {};
		quer = parseQuery(quer, options.parameters);
		function T(){}
		T.prototype = exports.operators;
		var operators = new T();
		// inherit from exports.operators
		for(var i in options.operators)
			operators[i] = options.operators[i];
		window.op = function(name){
			return operators[name]||exports.missingOperator(name);
		};
		var parameters = options.parameters || [];
		var js = "";
		function queryToJS(value){
			var item,
			    path,
			    escaped = [];

			if(value && typeof value === "object" && value.constructor !== Date){
				if(value instanceof Array){
					return "[" + value.map(queryToJS) + "]";
				}else{
					var jsOperator = exports.jsOperatorMap[value.name];
					if(jsOperator || /_*like/.test(value.name)){
						// item["foo.bar"] ==> (item && item.foo && item.foo.bar && ...)
						path = value.args[0];
						var target = value.args[1];

						if (typeof target == "undefined"){
							item = "item";
							target = path;
						} else {
							escaped = [];
							item = "item";
							path = path.split(".");
							for(var i = 0; i < path.length; i++){
								escaped.push(stringify(path[i]));
								item +="&&item[" + escaped.join("][") + "]";
							}
						}
						var condition;
						if(/_*like/.test(value.name)){
							var items = item.split("&&");
							item = items.slice(-1);

							condition = items.slice(0,-1);
							condition.push("(function(value){ return " +
								(value.name === "_like" ? "!" : "") +
								likeToString(value.args[1]) + "})(" + item + ")"
							);
							condition = condition.join("&&");
						} else {
							if(target.constructor === Date)
								condition = "(function(){ if(!(" + item + ")) var val = new Date(0); else { val = item[" + escaped.join("][") +
									"]; if(val.length !== undefined) val = new Date(val); } return val.valueOf()" +
									jsOperator + queryToJS(target)	+ "})()";
							else
								condition = item + jsOperator + queryToJS(target);
						}

						return "(function(){return this.filter(function(item){return " + condition + "})})";
					} else {
						switch(value.name){
							case "true": 	return true;
							case "false": 	return false;
							case "null": 	return null;
							case "empty": 	return stringify("");
							case "not":		return value && value.args && value.args.length > 0 ? queryToJS(value.args[0]) : "";
							default:
								return "(function(){return window.op('" + value.name + "').call(this" +
									(value && value.args && value.args.length > 0 ? (", " + value.args.map(queryToJS).join(",")) : "") +
									")})";
						}
					}
				}
			}else{
				if(typeof value === "string")
					return stringify(value);
				if(value.constructor === Date)
					return value.valueOf();
				return value;
			}
		}
		var _evaluator = new Function("target", "return " + queryToJS(quer) + ".call(target);"),
			evaluator = function(target){
				return _evaluator(target.slice(0));
			};

		return target ? evaluator(target) : evaluator;
	}

	exports.jsOperatorMap = {
		"eq" : "===",
		"ne" : "!==",
		"le" : "<=",
		"ge" : ">=",
		"lt" : "<",
		"gt" : ">"
	};
	exports.operators = {
		sort: function(){
			var terms = [],
				reg = /\./gi;
			for(var i = 0; i < arguments.length; i++){
				var sortAttribute = arguments[i],
					firstChar = sortAttribute.charAt(0),
					term = {attribute: sortAttribute, ascending: true};
				if (firstChar == "-" || firstChar == "+") {
					if(firstChar == "-"){
						term.ascending = false;
					}
					term.attribute = term.attribute.substring(1);
				}
				term.getItem = new Function("item", "return item[\"" + term.attribute.replace(reg, "\"][\"") + "\"];");
				terms.push(term);
			}

			this.sort(function(a, b){
				for (var term, i = 0; term = terms[i]; i++)
					if(term.getItem(a) != term.getItem(b))
						return term.ascending == term.getItem(a) > term.getItem(b) ? 1 : -1;
				return 0;
			});
			return this;
		},
		"in": filter(function(value, values){
			return values.indexOf(value) > -1;
		}),
		out: filter(function(value, values){
			return values.indexOf(value) == -1;
		}),
		contains: filter(function(array, value){
			if(typeof value == "function"){
				return array instanceof Array && each(array, function(v){
					return value.call([v]).length;
				});
			}
			else{
				return array instanceof Array && contains(array, value);
			}
		}),
		excludes: filter(function(array, value){
			if(typeof value == "function"){
				return !each(array, function(v){
					return value.call([v]).length;
				});
			}
			else{
				return !contains(array, value);
			}
		}),
		or: function(){
			var items = [];
			for(var i = 0; i < arguments.length; i++)
				items = items.concat(arguments[i].call(this));
			return items;
		},
		and: function(){
			var items = this;
			for(var i = 0; i < arguments.length; i++)
				items = arguments[i].call(items);
			return items;
		},
		select: function(){
			var args = arguments;
			var argc = arguments.length;
			return each(this, function(object, emit){
				var selected = {};
				for(var i = 0; i < argc; i++){
					var propertyName = args[i];
					var value = evaluateProperty(object, propertyName);
					if(typeof value != "undefined"){
						selected[propertyName] = value;
					}
				}
				emit(selected);
			});
		},
		unselect: function(){
			var args = arguments;
			var argc = arguments.length;
			return each(this, function(object, emit){
				var selected = {}, i;
				for (i in object) if (object.hasOwnProperty(i))	selected[i] = object[i];
				for(i = 0; i < argc; i++) delete selected[args[i]];
				emit(selected);
			});
		},
		values: function(first){
			if(arguments.length == 1){
				return each(this, function(object, emit){
					emit(object[first]);
				});
			}
			var args = arguments;
			var argc = arguments.length;
			return each(this, function(object, emit){
				var selected = [];
				if (argc === 0) {
					for(var i in object) if (object.hasOwnProperty(i)) {
						selected.push(object[i]);
					}
				} else {
					for(var i = 0; i < argc; i++){
						var propertyName = args[i];
						selected.push(object[propertyName]);
					}
				}
				emit(selected);
			});
		},
		limit: function(start, limit, maxCount){
			var totalCount = this.length;
			start = start || 0;
			var sliced = this.slice(start, start + limit);
			if(maxCount){
				sliced.start = start;
				sliced.end = start + sliced.length - 1;
				sliced.totalCount = Math.min(totalCount, typeof maxCount === "number" ? maxCount : Infinity);
			}
			return sliced;
		},
		distinct: function(){
			var primitives = {};
			var needCleaning = [];
			var newResults = this.filter(function(value){
				if(value && typeof value == "object"){
					if(!value.__found__){
						value.__found__ = function(){};// get ignored by JSON serialization
						needCleaning.push(value);
						return true;
					}
				}else{
					if(!primitives[value]){
						primitives[value] = true;
						return true;
					}
				}
			});
			each(needCleaning, function(object){
				delete object.__found__;
			});
			return newResults;
		},
		recurse: function(property){
			// TODO: this needs to use lazy-array
			var newResults = [];
			function recurse(value){
				if(value instanceof Array){
					each(value, recurse);
				}else{
					newResults.push(value);
					if(property){
						value = value[property];
						if(value && typeof value == "object"){
							recurse(value);
						}
					}else{
						for(var i in value){
							if(value[i] && typeof value[i] == "object"){
								recurse(value[i]);
							}
						}
					}
				}
			}
			recurse(this);
			return newResults;
		},
		aggregate: function(){
			var distinctives = [];
			var aggregates = [];
			for(var i = 0; i < arguments.length; i++){
				var arg = arguments[i];
				if(typeof arg === "function"){
					 aggregates.push(arg);
				}else{
					distinctives.push(arg);
				}
			}
			var distinctObjects = {};
			var dl = distinctives.length;
			each(this, function(object){
				var key = "";
				for(var i = 0; i < dl;i++){
					key += '/' + object[distinctives[i]];
				}
				var arrayForKey = distinctObjects[key];
				if(!arrayForKey){
					arrayForKey = distinctObjects[key] = [];
				}
				arrayForKey.push(object);
			});
			var al = aggregates.length;
			var newResults = [];
			for(var key in distinctObjects){
				var arrayForKey = distinctObjects[key],
					newObject = {},
					i;
				for(i = 0; i < dl;i++){
					var property = distinctives[i];
					newObject[property] = arrayForKey[0][property];
				}
				for(i = 0; i < al;i++){
					newObject[i] = aggregates[i].call(arrayForKey);
				}
				newResults.push(newObject);
			}
			return newResults;
		},
		between: filter(function(value, range){
			return value >= range[0] && value < range[1];
		}),
		sum: reducer(function(a, b){
			return a + b;
		}),
		mean: function(property){
			return exports.operators.sum.call(this, property)/this.length;
		},
		max: reducer(function(a, b){
			return Math.max(a, b);
		}),
		min: reducer(function(a, b){
			return Math.min(a, b);
		}),
		count: function(){
			return this.length;
		},
		first: function(){
			return this[0];
		},
		one: function(){
			if(this.length > 1){
				throw new TypeError("More than one object found");
			}
			return this[0];
		}
	};
	function reducer(func){
		return function(property){
			var result = this[0], i, l;
			if(property){
				result = result && result[property];
				for(i = 1, l = this.length; i < l; i++) {
					result = func(result, this[i][property]);
				}
			}else{
				for(i = 1, l = this.length; i < l; i++) {
					result = func(result, this[i]);
				}
			}
			return result;
		};
	}
	exports.filter = filter;
	exports.evaluateProperty = evaluateProperty;

	exports.executeQuery = function(query, options, target){
		return exports.query(query, options, target);
	};
	exports.query = query;
	exports.missingOperator = function(operator){
		throw new Error("Operator " + operator + " is not defined");
	};
	function throwMaxIterations(){
		throw new Error("Query has taken too much computation, and the user is not allowed to execute resource-intense queries. Increase maxIterations in your config file to allow longer running non-indexed queries to be processed.");
	}
	exports.maxIterations = 10000;
	return exports;
};

if(typeof define != "undefined") {
  define(["exports", "./parser", "./query", "./util/each", "./util/contains"], function(exports, parser, QUERY, each, contains){
    return exportFactory(exports, parser, QUERY, each, contains);
  });
}else {
  exportFactory(
    module.exports,
    require("./parser"),
    require("./query"),
    require("./util/each"),
    require("./util/contains")
  );
}
