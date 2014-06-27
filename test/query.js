var assert = require("assert"),
    Query = require("../query").Query,
    parseQuery = require("../parser").parseQuery;
exports.testJSArray = require("./js-array");

exports.testBehavior = function() {
    //assert.error(parseQuery(), "parseQuery requires a string");
    assert.ok(parseQuery("") instanceof Query, "should inherit from Query");
    assert.ok(parseQuery("a=b") instanceof Query, "should inherit from Query");
    //assert.error(parseQuery("?a=b"), "cannot begin with a ?");
};

var queryPairs = {
    "arrays": [
        {"a": {name:"and", args:["a"]}},
        {"(a)": {name:"and", args:[["a"]]}},
        {"a,b,c": {name:"and", args:["a", "b", "c"]}},
        {"(a,b,c)": {name:"and", args:[["a", "b", "c"]]}},
        {"a(b)": {name:"and","args":[{"name":"a","args":["b"]}]}},
        {"a(b,c)": {name:"and", args:[{name:"a", args:["b", "c"]}]}},
        {"a((b),c)": {"name": "and", args:[{name:"a", args:[["b"], "c"]}]}},
        {"a((b,c),d)": {name:"and", args:[{name:"a", args:[["b", "c"], "d"]}]}},
        {"a(b/c,d)": {name:"and", args:[{name:"a", args:[["b", "c"], "d"]}]}},
        {"a(b)&c(d(e))": {name:"and", args:[
            {name:"a", args:["b"]},
            {name:"c", args:[{name:"d", args:["e"]}]}
        ]}}
    ],
    "dot-comparison": [
    	{"foo.bar=3": {name:"and", args:[{name:"eq", args:["foo.bar",3]}]}},
    	{"select(sub.name)": {name:"and", args:[{name:"select", args:["sub.name"]}], cache: {select: ["sub.name"]}}}
    ],
    "equality": [
        {"eq(a,b)": {name:"and", args:[{name:"eq", args:["a","b"]}]}},
        {"a=eq=b": "eq(a,b)"},
        {"a=b": "eq(a,b)"}
    ],
    "inequality": [
        {"ne(a,b)": {name:"and", args:[{name:"ne", args:["a", "b"]}]}},
        {"a=ne=b": "ne(a,b)"},
        {"a!=b": "ne(a,b)"}
    ],
    "less-than": [
        {"lt(a,b)": {name:"and", args:[{name:"lt", args:["a", "b"]}]}},
        {"a=lt=b": "lt(a,b)"},
        {"a<b": "lt(a,b)"}
    ],
    "less-than-equals": [
        {"le(a,b)": {name:"and", args:[{name:"le", args:["a","b"]}]}},
        {"a=le=b": "le(a,b)"},
        {"a<=b": "le(a,b)"}
    ],
    "greater-than": [
        {"gt(a,b)": {name:"and", args:[{name:"gt", args:["a", "b"]}]}},
        {"a=gt=b": "gt(a,b)"},
        {"a>b": "gt(a,b)"}
    ],
    "greater-than-equals": [
        {"ge(a,b)": {name:"and", args:[{name:"ge", args:["a", "b"]}]}},
        {"a=ge=b": "ge(a,b)"},
        {"a>=b": "ge(a,b)"}
    ],
    "nested comparisons": [
        {"a(b(le(c,d)))": {name:"and", args:[{name:"a", args:[{name:"b", args:[{name:"le", args:["c", "d"]}]}]}]}},
        {"a(b(c=le=d))": "a(b(le(c,d)))"},
        {"a(b(c<=d))": "a(b(le(c,d)))"}
    ],
    "arbitrary FIQL desugaring": [
        {"a=b=c": {name:"and", args:[{name:"b", args:["a", "c"]}]}},
        {"a(b=cd=e)": {name:"and", args:[{name:"a", args:[{name:"cd", args:["b", "e"]}]}]}}
    ],
    "and grouping": [
        {"a&b&c": {name:"and", args:["a", "b", "c"]}},
        {"a(b)&c": {name:"and", args:[{name:"a", args:["b"]}, "c"]}},
        {"a&(b&c)": {"name":"and","args":["a",{"name":"and","args":["b","c"]}]}}
    ],
    "or grouping": [
        {"(a|b|c)": {name:"and", args:[{name:"or", args:["a", "b", "c"]}]}},
        {"(a(b)|c)": {name:"and", args:[{name:"or", args:[{name:"a", args:["b"]}, "c"]}]}}
    ],
    "complex grouping": [
        {"a&(b|c)": {name:"and", args:["a", {name:"or", args:["b", "c"]}]}},
        {"a|(b&c)": {name:"and", args:[{name:"or", args:["a", {name:"and", args:["b", "c"]}]}]}},
        {"a(b(c<d,e(f=g)))": {}}
    ],
    "complex comparisons": [

    ],
    "string coercion": [
        {"a(string)": {name:"and", args:[{name:"a", args:["string"]}]}},
        {"a(string:b)": {name:"and", args:[{name:"a", args:["b"]}]}},
        {"a(string:1)": {name:"and", args:[{name:"a", args:["1"]}]}}
    ],
    "number coercion": [
        {"a(number)": {name:"and", args:[{name:"a", args:["number"]}]}},
        {"a(number:1)": {name:"and", args:[{name:"a", args:[1]}]}}
//        {"a(number:b)": {name:"and", args:[{name:"a", args:[NaN]}]}} // supposed to throw an error
    ],
    "date coercion": [
        //FIXME do we need proper ISO date subset parsing?
        {"a(date)": {name:"and", args:[{name:"a", args:["date"]}]}},
        {"a(date:2009)": {name:"and", args:[{name:"a", args:[(new Date("2009"))]}]}},
        //{"a(date:b)": {name:"and", args:[{name:"a", args:[(new Date(NaN))]}]}} // XXX?// supposed to throw an error
    ],
    "boolean coercion": [
        {"a(true)": {name:"and", args:[{name:"a", args:[true]}]}},
        {"a(false)": {name:"and", args:[{name:"a", args:[false]}]}},
        {"a(boolean:true)": {name:"and", args:[{name:"a", args:[true]}]}}
    ],
    "null coercion": [
        {"a(null)": {name:"and", args:[{name:"a", args:[null]}]}},
        {"a(auto:null)": {name:"and", args:[{name:"a", args:[null]}]}},
        {"a(string:null)": {name:"and", args:[{name:"a", args:["null"]}]}}
    ],
    "complex coercion": [
        {"(a=b|c=d)&(e=f|g=1)": {"name":"and","args":[{"name":"or","args":[{"name":"eq","args":["a","b"]},{"name":"eq","args":["c","d"]}]},
        {"name":"or","args":[{"name":"eq","args":["e","f"]},{"name":"eq","args":["g",1]}]}]}}
    ],
    "complex grouping": [

    ]
};

exports.testParsing = function() {
    for (var group in queryPairs) {
        queryPairs[group].forEach(function(pair) {
            var key = Object.keys(pair)[0];
            try{
	            var parsed = parseQuery(key);
	            if (!Object.keys(parsed.cache).length)
							  delete parsed.cache;
	            var result = pair[key];
	            if(typeof result == "string"){
	            	result = parseQuery(result);
  	            if (!Object.keys(result.cache).length)
									delete result.cache;
	            }
            }catch(e){
            	e.message += " parsing " + group + ": " + key;
            	throw e;
            }
            try{
            	var serialized = JSON.stringify(parsed);
            }catch(e){
            	serialized = e.message;
            }
            assert.deepEqual(parsed, result, group + ": " + key + " " + serialized);
        });
    }
};

exports.testBindParameters = function() {
    // TODO
    var parsed;
    parsed = parseQuery('in(id,$1)', [['a','b','c']]);
    assert.deepEqual(parsed, {name: 'and', args: [{name: 'in', args: ['id', ['a', 'b', 'c']]}], cache: {}});
    parsed = parseQuery('eq(id,$1)', ['a']);
    assert.deepEqual(parsed, {name: 'and', args: [{name: 'eq', args: ['id', 'a']}], cache: {id: 'a'}});
};

exports.testStringification = function() {
    // TODO
    var parsed;
    parsed = parseQuery('eq(id1,RE:%5Eabc%5C%2F)');
    // Hmmm. deepEqual gives null for regexps?
    assert.ok(parsed.args[0].args[1].toString() === /^abc\//.toString());
    //assert.deepEqual(parsed, {name: 'and', args: [{name: 'eq', args: ['id1', /^abc\//]}]});
    assert.ok(Query().eq('_1',/GGG(EE|FF)/i)+'' === 'eq(_1,re:GGG%28EE%7CFF%29)');
    parsed = parseQuery('eq(_1,re:GGG%28EE%7CFF%29)');
    console.log(parsed.args[0].args[1].toString() === /GGG(EE|FF)/i.toString());
    //assert.ok(Query().eq('_1',/GGG(EE|FF)/)+'' === 'eq(_1,RE:GGG%28EE%7CFF%29)');
    // string to array and back
    var str = 'somefunc(and(1),(a,b),(10,(10,1)),(a,b.c))';
    assert.equal(parseQuery(str)+'', str);
    // quirky arguments
    var name = ['a/b','c.d'];
    assert.equal(parseQuery(Query().eq(name,1)+'')+'', 'eq((a%2Fb,c.d),1)');
    assert.deepEqual(parseQuery(Query().eq(name,1)+'').args[0].args[0], name);
};

exports.testMatches = function () {
    var query = Query().match('name', /Will*/);
    assert.equal('' + query, 'match(name,RE:Will*)');
}

if (require.main === module)
    require("patr/runner").run(exports);
