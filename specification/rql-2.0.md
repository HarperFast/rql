# Resource Query Language (RQL) 2.0

**Status:** Draft — pre-review skeleton, not yet ratified
**Editor:** Kris Zyp
**Supersedes:** [draft-zyp-rql-00](./draft-zyp-rql-00.xml) (RQL 1.x)

---

## 1. Introduction

Resource Query Language (RQL) is a query language designed for use in URIs, particularly
as the query component of a URL, for querying collections of resources with object-style
data structures. RQL 2.0 is a **clean-break revision** of RQL 1.x that specifies the query
language as implemented and evolved by [Harper](https://github.com/HarperFast/harper)'s
REST interface, which descends from RQL 1.x and [FIQL].

RQL 2.0 consists of:

- a **surface grammar** (§4) for conditions, logical composition, and call-style query
  functions, designed to be a compatible superset of HTML form URL encoding and of FIQL;
- **operator semantics** (§5) for comparison, negation, range chaining, wildcards, typed
  value coercion, property paths, and the `select`/`sort`/`limit` functions;
- a **canonical parsed representation** (§6) — the AST every conforming parser produces;
- **conformance profiles** (§8): *Core* (this document, normative) and *Extensions*
  (Appendix C, reserved operator names carried forward from RQL 1.x).

Where RQL 1.x and current practice diverge, 2.0 specifies current practice; Appendix A
enumerates every break for 1.x migrators.

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD
NOT", "RECOMMENDED", "MAY", and "OPTIONAL" are to be interpreted as described in RFC 2119.

- **query** — the full string being parsed (the URL query component, without the leading `?`).
- **condition** — a single comparison of a property (path) against a value or value list.
- **group** — a parenthesized or bracketed sub-query combining terms with one logical operator.
- **call function** — a named, parenthesized top-level directive (`sort(...)`, `select(...)`,
  `limit(...)`) that shapes the result set rather than filtering it.
- **comparator** — the named comparison operation of a condition (`eq`, `lt`, `contains`, …).

## 3. Design principles

1. **URL-native.** A query MUST be expressible in a URL query component with standard
   percent-encoding. Unreserved characters need no encoding; encoded octets are decoded
   *after* tokenization, so delimiters can be embedded in values via percent-encoding.
2. **Form-encoding superset.** `?foo=3&bar=4` — plain HTML form encoding — is a valid RQL
   query meaning the conjunction of two equality conditions. Implementations MAY represent
   such simple queries without constructing condition objects (§6.3).
3. **FIQL superset.** `price=lt=10` (FIQL named-operator syntax) is valid and equivalent
   to the symbolic form `price<10`.
4. **Extensible.** Comparator names and call-function names are open identifier sets;
   parsers MUST accept unknown FIQL comparator names syntactically (§5.1) and reject
   unknown *call functions* at parse time (§5.6). Semantic validation of comparators is
   deferred to execution.

## 4. Grammar

Draft ABNF (RFC 5234). This grammar describes the normative surface; §4.1 notes the
tolerances a parser MAY additionally provide.

```abnf
query          = [ group-body ]
group-body     = term *( conjunction term )
               ; all conjunctions within one group-body MUST be identical (§5.4)
conjunction    = "&" / "|"
term           = condition / chained-cond / call / group / form-pair
group          = "(" group-body ")" / "[" group-body "]"

condition      = prop-path symbol-op value
               / prop-path "=" fiql-name "=" ( value / value-list )
chained-cond   = ( "&=" / "|=" ) [ fiql-name "=" ] value
               ; continues the preceding condition's property (§5.3)
form-pair      = prop-path "=" value            ; strict equality (§5.2)

symbol-op      = "=" / "==" / "===" / "!=" / "!==" / "<" / "<=" / ">" / ">="
fiql-name      = ALPHA-UNDER *( ALPHA-UNDER / DIGIT )
ALPHA-UNDER    = ALPHA / "_"

prop-path      = prop-segment *( "." prop-segment )
prop-segment   = 1*pchar-noDot
value          = 1*vchar / typed-value / wildcard-value
typed-value    = type-name ":" 1*vchar          ; §5.5
value-list     = "(" [ value *( "," value ) ] ")"
wildcard-value = 1*vchar "*"                    ; only with "==" (§5.1.3)

call           = call-name "(" [ call-args ] ")"
call-name      = 1*( ALPHA / DIGIT / "-" / "_" )
call-args      = call-arg *( "," call-arg )
call-arg       = value / sort-key / select-item
sort-key       = [ "+" / "-" ] prop-path
select-item    = prop-path
               / prop-path "{" select-list "}"          ; brace sub-select
               / prop-path "[" "select" "(" select-list ")" "]"  ; bracket sub-select
               / "[" select-list "]"                    ; array-shaped rows
select-list    = select-item *( "," select-item )
```

### 4.1 Parsing tolerances (non-normative surface, normative behavior)

- **Delimiters inside values.** Once a comparator has been consumed, a parser switches to
  value scanning in which `(`, `)`, `<`, `>` and `!` MAY appear unescaped and are taken
  literally (e.g. `foo=ba)r` is the value `ba)r`). Producers SHOULD percent-encode them
  anyway. Square brackets retain structural meaning in value position (they open/close
  groups), which is why `[...]` grouping is RECOMMENDED for machine-constructed queries:
  standard URI component encoding safely escapes `[` and `]` but not `(` and `)`.
- **Percent-decoding order.** Tokenization happens on the raw string; each token is
  percent-decoded afterward. Consequently a literal `.` inside a property *segment* cannot
  be expressed — `%2E` is decoded after path splitting. (Known limitation, carried from
  the reference implementation.)
- **Repeated array parameters.** `prop[]=v1&prop[]=v2` (PHP/Rails convention) is accepted
  and equivalent to membership conditions on `prop`.

## 5. Semantics — Core profile

### 5.1 Comparators

#### 5.1.1 Symbolic operators

| Syntax | Comparator | Coercion (§5.5) |
|---|---|---|
| `prop=value` | `equals` | none — strict string (schema type MAY convert) |
| `prop===value` | `equals` | none — strict |
| `prop==value` | `eq` | automatic |
| `prop!=value` | `ne` | automatic |
| `prop!==value` | `not_equal` | none — strict |
| `prop<value`, `prop<=value` | `lt`, `le` | automatic |
| `prop>value`, `prop>=value` | `gt`, `ge` | automatic |

> **Break from 1.x:** in RQL 1.x, `prop=value` auto-converted (it was sugar for `eq`).
> In 2.0 bare `=` is *strict*; `==` is the coercive equality. See Appendix A.

#### 5.1.2 FIQL named comparators

`prop=name=value` where `name` matches `fiql-name`. Parsers MUST accept any syntactically
valid name and defer unknown-comparator rejection to execution. The canonical Core set and
its aliases:

| Canonical | Aliases | Notes |
|---|---|---|
| `eq` | | coercive equality |
| `equals` | | strict equality |
| `ne` | `not_equal` (strict variant distinct) | |
| `lt` `le` `gt` `ge` | `less_than`, `greater_than`, camelCase forms | |
| `contains` | `ct`, `includes` | string/array containment |
| `starts_with` | `sw` | |
| `ends_with` | `ew` | |
| `in` | | takes a value list |
| `between` | | takes a two-element value list, inclusive |

**Negation:** prefixing `not_` to `in`, `between`, `starts_with`, `ends_with`, `contains`,
or `equals` negates the comparator (`tag=not_in=(a,b)`). `not_equal` is NOT a negation of
`equal` under this rule — it is its own (strict) comparator, for 1.x-lineage compatibility.

**Value lists:** `(v1,v2,…)` is interpreted as a list **only** for `in` and `between`
(and their negations); each element is coerced individually and MAY be typed (§5.5).
`()` is the empty list. For any other comparator a parenthesized token is the literal
string including its parentheses (legacy tolerance; producers MUST NOT rely on it).

#### 5.1.3 Wildcards

A trailing `*` on the value of a coercive equality (`==`) condition rewrites the condition
to `starts_with` with the `*` removed: `name==Jo*` ≡ `name=starts_with=Jo`. A leading or
embedded `*` is a syntax error. Wildcards apply to no other comparator.

### 5.2 Strict vs. coercive comparison

Strict comparators (`=`, `===`, `!==`) treat the value as the percent-decoded string; if
the target schema declares a type for the property, the schema type governs conversion.
Coercive comparators (everything else) apply automatic literal conversion (§5.5) before
schema typing.

### 5.3 Range chaining

`&=` and `|=` chain an additional comparison onto the *preceding condition's property*:

```
age=ge=20&=le=30        ; 20 ≤ age ≤ 30
```

Chained conditions attach to the prior condition (AST: `chainedConditions`, §6) and are
intended for contiguous range constraints; executors typically collapse
`ge/gt` + `le/lt` pairs into a single inclusive/exclusive range scan.

### 5.4 Logical composition and grouping

- `&` is conjunction, `|` is disjunction.
- Within one group nesting level, `&` and `|` MUST NOT be mixed; use `(...)` or `[...]`
  to disambiguate: `a=1&[b=2|c=3]`.
- `(...)` and `[...]` are semantically identical groupings (see §4.1 for why brackets are
  RECOMMENDED in generated queries).

### 5.5 Values and typed literals

Coercive comparators convert value tokens as follows:

| Token | Converts to |
|---|---|
| `null` | null |
| `number:N` | number (decimal) |
| `number:$X` | number, `X` parsed base-36 |
| `boolean:true` / `boolean:false` | boolean |
| `date:ISO-8601` or `date:epochMillis` | Date |
| `string:S` | percent-decoded string (suppresses further coercion) |
| bare token | percent-decoded string; implementations MAY additionally auto-convert schema-untyped numerics/booleans |
| unknown `type:` prefix | error (400) |

> **Break from 1.x:** the 1.x converters `re:`, `RE:`, `glob:`, `epoch:`, `isodate:` and
> the `$1`-style positional parameters are removed. String matching uses
> `contains`/`starts_with`/`ends_with` and the `==prefix*` wildcard.

### 5.6 Call functions

Exactly these call functions are Core; an unrecognized call name is a parse error
(unlike comparator names, which are open):

> **Break from 1.x:** in RQL 1.x, call syntax was the *normalized form* of every
> operator — `lt(price,10)` was equivalent to `price=lt=10`, and infix forms were sugar.
> In 2.0 the categories are disjoint: comparators are infix-only with an open name set
> (§5.1.2), and call syntax is reserved for this closed set of result-shaping functions.
> `lt(price,10)` is a parse error. The anonymous group `(...)` (§5.4) is the one place
> call syntax still yields conditions.

| Function | Semantics |
|---|---|
| `select(...)` | Projection. Four shapes: `select(a)` → scalar values of `a`; `select(a,b)` → objects with those properties (`select(a,)` for a one-property object); `select([a,b])` → rows as arrays; sub-selects `rel{a,b}` or `rel[select(a,b)]` project into related/nested objects. |
| `sort(k1,k2,…)` | Each key optionally prefixed `+` (ascending, default) or `-` (descending); later keys break ties. Keys may be dotted paths. |
| `limit(end)` / `limit(start,end)` | **Start/end bounds, not offset/count**: `limit(5,10)` means offset 5, at most 5 records. |
| `group-by(...)` | Reserved. Parsers MUST accept the syntax; Core executors report "not implemented". |
| `(...)` (anonymous) | Grouping, §5.4. |

> **Break from 1.x:** 1.x `limit(count,start,maxCount)` is replaced by the
> Dojo-store-range `limit(start,end)` form. See Appendix A.

### 5.7 Property paths

Dot syntax addresses nested properties and — where the schema declares relationships —
traverses them: `brand.name=Microsoft` (filtering through a relationship has inner-join
semantics; projecting an unfiltered relationship via `select` has left-join semantics).

> **Break from 1.x:** 1.x slash paths (`foo/bar`) and tuple paths (`(foo,bar)`) are removed.

## 6. Canonical parsed representation

### 6.1 Query object

A conforming parser produces (or populates) a **Query**: an object that *extends
`URLSearchParams`* (or is duck-type compatible: `[Symbol.iterator]`, `get`, `getAll`) and
carries:

```ts
class Query extends URLSearchParams {
	conditions: Condition[];        // filter terms, in source order
	operator?: 'and' | 'or';        // top-level conjunction (default 'and')
	sort?: Sort;                    // linked list
	select?: Select;
	limit?: number;
	offset?: number;
	parseError?: Error;             // deferred semantic error (§6.4)
}
```

Host frameworks MAY subclass Query — e.g. Harper's `RequestTarget extends Query` — and
pass the instance to the parser for in-place population.

### 6.2 Conditions

```ts
type Condition =
	| { attribute: string | string[];   // string[] = dotted path segments
	    comparator: Comparator;
	    value: unknown;
	    negated?: boolean;              // from not_ prefix
	    chainedConditions?: Condition[] } // from &= / |=
	| { conditions: Condition[]; operator: 'and' | 'or' }   // group node
	| [name: string, value: string];    // fast-path entry (§6.3)

type Sort   = { attribute: string | string[]; descending?: boolean; next?: Sort };
type Select = string | (string | SubSelect)[]; // plus asArray / named-sub-select variants
type SubSelect = { name: string; select: (string | SubSelect)[] };
```

Consumers MUST read conditions shape-agnostically: `attribute = c[0] ?? c.attribute`,
`value = c[1] ?? c.value` (a tuple's comparator is implicitly strict `equals`).

### 6.3 The simple-query fast path

A query containing none of `( ) [ ] | ! < > .` and no `=name=` sequence is plain form
encoding. Implementations MAY skip condition construction entirely and expose it through
the Query's `URLSearchParams` interface; consumers see `[name, value]` tuple conditions.
This is a deliberate performance affordance of the representation, not an optional
serialization: conforming consumers MUST handle both shapes.

### 6.4 Error model

Structural syntax violations (unbalanced groups, illegal wildcard, unknown call function,
unknown `type:` prefix) are client errors (HTTP 400). When the parser populates a
caller-supplied Query, semantic errors are RECOMMENDED to be *deferred*: accumulated into
`parseError` and raised at execution, so that a request pipeline controls where the
failure surfaces.

## 7. Serialization

TODO: normalization rules for emitting a Query back to a canonical string (needed for
caching keys and equivalence testing). Candidate: FIQL named form, `[...]` grouping,
sorted call-function order (`select`, `sort`, `limit` last).

## 8. Conformance

- **Core parser:** implements §4–§6 exactly; validated by the conformance suite
  (`test/v2/` in the reference implementation, seeded from Harper's parser tests).
- **Core executor:** implements Core comparator/call semantics over a collection.
- **Extensions (Appendix C):** optional; names are reserved and MUST NOT be repurposed.

## 9. Security considerations

TODO: complexity/DoS bounds (nesting depth, condition count), percent-decoding pitfalls,
injection via property paths into schema-less stores, regex-free matching guarantees.

---

## Appendix A — Breaking changes from RQL 1.x (migration)

| Area | RQL 1.x | RQL 2.0 |
|---|---|---|
| Operator model | one category: call form `op(args)` is the normalized form of everything; infix is sugar | two disjoint categories: infix-only comparators (open set, execution-validated) vs. call-only result-shaping functions (closed set, parse-validated) |
| `lt(price,10)` etc. | valid, ≡ `price=lt=10` | parse error — comparators have no call form |
| `prop=value` | coercive `eq` | **strict** `equals`; use `==` for coercion |
| `limit` | `limit(count,start,maxCount)` | `limit(end)` / `limit(start,end)` |
| Nested paths | `foo/bar`, `(foo,bar)` | `foo.bar` |
| Grouping | `(...)` only | `(...)` and `[...]` |
| String matching | `re:`/`RE:`/`glob:` converters, `match` | `contains`/`starts_with`/`ends_with`, `==prefix*` |
| Converters | `epoch:`, `isodate:`, `re:`, `glob:` | removed; `date:` accepts ISO-8601 or epoch ms |
| Positional params | `$1`, `$2` | removed |
| Negation | none | `not_` comparator prefix |
| Range chaining | none | `&=` / `|=` |
| Sub-selects | none | `rel{a,b}`, `rel[select(a)]`, `select([a,b])` |
| AST | generic `{name, args}` term tree | typed Query (§6); generic terms remain a non-normative encoding for Extensions |
| Aggregation etc. | Core operators | moved to Extensions profile (Appendix C) |

## Appendix B — Relationship to FIQL

RQL 2.0 remains a superset of FIQL's `selector comparison-op argument` form with `=name=`
operators; it does not adopt FIQL's `;`/`,` conjunction syntax (RQL uses `&`/`|`).

## Appendix C — Extensions profile (reserved from 1.x)

Reserved call-function names carried from RQL 1.x, non-normative pending a future
revision: `aggregate`, `distinct`, `values`, `sum`, `mean`, `max`, `min`, `count`,
`first`, `one`, `recurse`, `rel`, `group-by`.
