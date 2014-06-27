var assert = require("assert"),
	Query = require("../query").Query,
    executeQuery = require("../js-array").executeQuery;

var data = [
	{
		"with/slash": "slashed",
		"nested": {
			"property": "value"
		},
		"price": 10,
		"name": "ten",
		"tags": ["fun", "even"]
	},
	{
		"price": 5,
		"name": "five",
		"tags": ["fun"]
	}];

exports.testFiltering = function() {
	assert.equal(executeQuery("price=lt=10", {}, data).length, 1); 
	assert.equal(executeQuery("price=lt=11", {}, data).length, 2); 
	assert.equal(executeQuery("nested/property=value", {}, data).length, 1); 
	assert.equal(executeQuery("with%2Fslash=slashed", {}, data).length, 1); 
	assert.equal(executeQuery("out(price,(5,10))", {}, data).length, 0); 
	assert.equal(executeQuery("out(price,(5))", {}, data).length, 1); 
	assert.equal(executeQuery("contains(tags,even)", {}, data).length, 1); 
	assert.equal(executeQuery("contains(tags,fun)", {}, data).length, 2); 
	assert.equal(executeQuery("excludes(tags,fun)", {}, data).length, 0); 
	assert.equal(executeQuery("excludes(tags,ne(fun))", {}, data).length, 1); 
	assert.equal(executeQuery("excludes(tags,ne(even))", {}, data).length, 0); 
	// eq() on re: should trigger .match()
	assert.deepEqual(executeQuery("price=match=10", {}, data), [data[0]]);
	// ne() on re: should trigger .not(.match())
	assert.deepEqual(executeQuery("name=match=f.*", {}, data), [data[1]]);
	assert.deepEqual(executeQuery("name=match=glob:f*", {}, data), [data[1]]);
	assert.deepEqual(executeQuery(new Query().match('name', /f.*/), {}, data), [data[1]]);
};

exports.testFiltering1 = function() {
	var data = [{"path.1":[1,2,3]}, {"path.1":[9,3,7]}];
	assert.deepEqual(executeQuery("contains(path,3)&sort()", {}, data), []); // path is undefined
	assert.deepEqual(executeQuery("contains(path.1,3)&sort()", {}, data), data); // 3 found in both
	assert.deepEqual(executeQuery("excludes(path.1,3)&sort()", {}, data), []); // 3 found in both
	assert.deepEqual(executeQuery("excludes(path.1,7)&sort()", {}, data), [data[0]]); // 7 found in second
};

if (require.main === module)
    require("patr/runner").run(exports);
