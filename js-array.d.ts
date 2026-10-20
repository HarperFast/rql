import {Query} from './query'
declare namespace RqlArray {
    export function executeQuery(query: string | Query, options: any, target: any[]);
}

export = RqlArray;