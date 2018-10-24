function contains(array, item){
	for(var i = 0, l = array.length; i < l; i++){
		if(array[i] === item){
			return true;
		}
	}
}

if(typeof define != "undefined") {
	define([], function() {
	  return contains;
	});
  }else {
	module.exports = contains;
}  
