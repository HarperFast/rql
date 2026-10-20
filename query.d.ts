declare namespace RqlQuery {
    function updateQueryMethods();
    export type defaultOperator = (...params: any[]) => any;
    const knownOperators: string[];
    class Query {
        /**
         * Filters for objects where the specified property's value is equal to the provided value
         * 
         * @param {string} property 
         * @param {*} value 
         * @returns {Query} 
         * @memberof Query
         */
        eq(property: string, value: any): Query;

        /**
         * Filters for objects where the specified property's value is like to the provided value. Supports * and ?
         *
         * @param {string} property
         * @param {*} value
         * @returns {Query}
         * @memberof Query
         */
        like(property: string, value: any): Query;

        /**
         * Filters for objects where the specified property's value is not equal to the provided value
         * 
         * @param {string} property 
         * @param {*} value 
         * @returns {Query} 
         * @memberof Query
         */
        ne(property: string, value: any): Query;
        
        /**
         * Filters for objects where the specified property's value is greater than the provided value
         * 
         * @param {string} property 
         * @param {*} value 
         * @returns {Query} 
         * @memberof Query
         */
         gt(property: string, value: any): Query;
        
         /**
         * Filters for objects where the specified property's value is less than the provided value
         * 
         * @param {string} property 
         * @param {*} value 
         * @returns {Query} 
         * @memberof Query
         */
        lt(property: string, value: any): Query;
        
        /**
         * Filters for objects where the specified property's value is greater than or equal to the provided value
         * 
         * @param {string} property 
         * @param {*} value 
         * @returns {Query} 
         * @memberof Query
         */
        ge(property: string, value: any): Query;
        
        /**
         * Filters for objects where the specified property's value is less than or equal to the provided value
         * 
         * @param {string} property 
         * @param {*} value 
         * @returns {Query} 
         * @memberof Query
         */
        le(property: string, value: any): Query;

        /**
         * Filters for objects where the specified property's value is an array and the array contains any value that equals the provided value or satisfies the provided expression.
         * 
         * @param {string} property 
         * @param {*} value 
         * @returns {Query} 
         * @memberof Query
         */
        contains(property: string, value: any): Query;
        
        /**
         * Trims each object down to the set of properties defined in the arguments
         * 
         * @param {...string[]} properties 
         * @returns {Query} 
         * @memberof Query
         */
        select(...properties: string[]): Query;

        /**
         * Returns the given range of objects from the result set
         * 
         * @param {number} count 
         * @param {number} [top] 
         * @returns {Query} 
         * @memberof Query
         */
        limit(count: number, top?: number): Query;
        /**
         * Sorts by the given property in order specified by the prefix (+ for ascending, - for descending)
         * 
         * @param {string[]} property 
         * @returns {Query} 
         * @memberof Query
         */
        sort(...property: string[]): Query;

        /**
         * The union of the given queries
         * 
         * @param {...Query[]} queries 
         * @returns {Query} 
         * @memberof Query
         */
        or(...queries: Query[]): Query;

        /**
         * Applies all the given queries
         * 
         * @param {...Query[]} queries 
         * @returns {Query} 
         * @memberof Query
         */
        and(...queries: Query[]): Query;

        /**
         * Convert the query to its string representation
         * 
         * @returns {string} 
         * @memberof Query
         */
        toString(): string;

        /**
         * Add a query
         * 
         * @param {Query} query 
         * @returns {Query} 
         * @memberof Query
         */
        push(query: Query): Query;
        
        /**
         * Returns the first record of the query's result set
         * 
         * @returns {Query} 
         * @memberof Query
         */
        first(): Query;

        /**
         * Returns the count of the number of records in the query's result set
         * 
         * @returns {Query} 
         * @memberof Query
         */
        count(): Query;
        
        /**
         * Returns the first and only record of the query's result set, or produces an error if the query's result set has more or less than one record in it.
         * 
         * @returns {Query} 
         * @memberof Query
         */
        one(): Query;
        
        /**
         * Finds the sum of every value in the array or if the property argument is provided, returns the sum of the value of property for every object in the array
         * 
         * @param {string} property 
         * @memberof Query
         */
        sum(property: string);

        /**
         *  Finds the minimum of every value in the array or if the property argument is provided, returns the minimum of the value of property for every object in the array
         * 
         * @param {string} property 
         * @memberof Query
         */
        min(property: string);

        /**
         * Finds the maximum of every value in the array or if the property argument is provided, returns the maximum of the value of property for every object in the array
         * 
         * @param {string} property 
         * @memberof Query
         */
        max(property: string);

        executor: (query: Query) => any;
        match: defaultOperator;
        in: defaultOperator;
        out: defaultOperator;
        excludes: defaultOperator;
        values: defaultOperator;
        distinct: defaultOperator;
        recurse: defaultOperator;
        aggregate: defaultOperator;
        between: defaultOperator;
        mean: defaultOperator;
    }
}

export = RqlQuery;