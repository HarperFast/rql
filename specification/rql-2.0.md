# Resource Query Language (RQL) 2.0

**Status:** Draft — pre-review, not yet ratified
**Editor:** Kris Zyp
**Supersedes:** [draft-zyp-rql-00](./draft-zyp-rql-00.xml) (RQL 1.x)

---

## 1. Introduction

Resource Query Language (RQL) is a query language designed for use in URIs, particularly
as the query component of a URL, for querying collections of resources with object-style
data structures. RQL 2.0 is a **clean-break revision** of RQL 1.x, informed by fifteen
years of production use of the RQL/FIQL lineage — most directly in
[Harper](https://github.com/HarperFast/harper)'s REST interface.

RQL 2.0 specifies the *ideal* language: the cleanest coherent semantics for the syntax in
real-world use. It is deliberately **not** a reverse-engineering of any single
implementation. Existing implementations (including Harper's) are expected to converge
toward it; their known divergences are cataloged (Appendix D) rather than normalized into
the language. The specification is language-neutral: the canonical parsed representation
(§6) is an abstract data model, intended to support reference implementations in multiple
programming languages.

RQL 2.0 consists of:

- a **surface grammar** (§4) for conditions, logical composition, and call-style query
  functions, designed to be a compatible superset of HTML form URL encoding and of FIQL;
- **operator semantics** (§5): a small orthogonal comparator set with uniform negation,
  typed value literals, range chaining, property paths, and the `select`/`sort`/`limit`
  functions;
- a **canonical parsed representation** (§6) — the abstract data model every conforming
  parser produces, into which all surface sugar desugars;
- **conformance profiles** (§8): *Core* (this document, normative) and *Extensions*
  (Appendix C, reserved operator names carried forward from RQL 1.x).

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD
NOT", "RECOMMENDED", "MAY", and "OPTIONAL" are to be interpreted as described in RFC 2119.

- **query** — the full string being parsed (the URL query component, without the leading `?`).
- **condition** — a single comparison of a property path against a value.
- **group** — a parenthesized or bracketed sub-query combining terms with one logical operator.
- **call function** — a named, parenthesized top-level directive (`sort(...)`, `select(...)`,
  `limit(...)`) that shapes the result set rather than filtering it.
- **comparator** — the named comparison operation of a condition (`eq`, `lt`, `contains`, …).
- **desugar** — the mapping from a surface convenience form to its canonical representation;
  sugar exists only in the surface syntax, never in the data model.

## 3. Design principles

1. **URL-native.** A query MUST be expressible in a URL query component with standard
   percent-encoding. Tokenization happens on the raw string; percent-decoding is applied
   per token *after* structural parsing (§4.2), so any delimiter can be embedded in a
   value or property segment by percent-encoding it.
2. **Form-encoding superset.** `?foo=3&bar=4` — plain HTML form encoding — is a valid RQL
   query meaning the conjunction of two equality conditions on verbatim string values.
3. **FIQL superset.** `price=lt=10` (FIQL named-operator syntax) is valid and equivalent
   to the symbolic form `price<10`.
4. **Small canonical core, rich sugar.** The data model has one equality, one negation
   mechanism, and one way to express a range. Convenience surface forms (`!=`, `===`,
   wildcards, `between`, chaining) all desugar to it.
5. **Extensible.** FIQL comparator names are an open identifier set — parsers MUST accept
   unknown names syntactically and defer semantic validation to execution. Call-function
   names are a closed set validated at parse time (§5.6).
6. **Language-neutral.** The canonical representation is defined abstractly; bindings for
   particular languages map it to native structures but MUST preserve its shape.

## 4. Grammar

Draft ABNF (RFC 5234). §4.1 notes tolerances a parser MAY additionally provide.

```abnf
query          = [ group-body ] *( "&" call )
group-body     = term *( conjunction term )
               ; all conjunctions within one group-body MUST be identical (§5.4)
conjunction    = "&" / "|"
term           = condition / chained-cond / group / scoped-match
group          = "(" group-body ")" / "[" group-body "]"
scoped-match   = prop-path "[" group-body "]"
               ; element-scoped sub-query over the values at prop-path (§5.3);
               ; inner paths are element-relative

condition      = prop-path symbol-op value
               / prop-path "=" fiql-name "=" ( value / value-list )
chained-cond   = ( "&=" / "|=" ) fiql-name "=" value
               ; continues the preceding condition, scoped to the same element (§5.3)

symbol-op      = "=" / "==" / "===" / "!=" / "!==" / "<" / "<=" / ">" / ">="
fiql-name      = ALPHA-UNDER *( ALPHA-UNDER / DIGIT )
ALPHA-UNDER    = ALPHA / "_"

prop-path      = prop-segment *( "." prop-segment )
prop-segment   = 1*seg-char             ; percent-decoded after path splitting (§4.2)

value          = plain-value / typed-value / wildcard-value
plain-value    = *vchar
typed-value    = type-name ":" *vchar   ; §5.2.2
value-list     = "(" [ value *( "," value ) ] ")"
wildcard-value = 1*vchar "*"            ; only with "==" (§5.1.2)

call           = call-name "(" [ call-args ] ")"
call-name      = 1*( ALPHA / DIGIT / "-" / "_" )
call-args      = call-arg *( "," call-arg )
call-arg       = value / sort-key / select-item
sort-key       = [ "+" / "-" ] prop-path
select-item    = prop-path
               / prop-path "{" select-list "}"                    ; nested projection
               / prop-path "[" "select" "(" select-list ")" "]"   ; equivalent bracket form
               / "[" select-list "]"                              ; tuple-shaped rows
select-list    = select-item *( "," select-item )
```

### 4.1 Parsing tolerances

- **Delimiters inside values.** Once a comparator has been consumed, a parser MAY scan
  the value leniently, taking `(`, `)`, `<`, `>`, and `!` as literal characters (e.g.
  `foo=ba)r` as the value `ba)r`). Producers MUST percent-encode reserved characters in
  values; the lenient scan is a consumer tolerance, not a producer license. Square
  brackets retain structural meaning even in value position, which is one reason `[...]`
  grouping is RECOMMENDED for machine-constructed queries: standard URI component
  encoding escapes `[` and `]` but not `(` and `)`.

### 4.2 Percent-encoding layering

Structural parsing operates on the raw (encoded) string; percent-decoding applies per
token afterward:

1. Tokenize on the reserved delimiters (`&`, `|`, `=`, comparators, parentheses,
   brackets, braces, commas).
2. Split property paths on **literal** (unencoded) `.`.
3. Percent-decode each resulting property segment and each value token.

Consequently `%2E` within a property segment denotes a literal `.` in that segment's
name: `a%2Eb==3` is a condition on the single property named `a.b`, while `a.b==3` is a
condition on the path `a` → `b`. The same rule gives `%26`, `%7C`, `%28`, `%2C`, etc.
their expected meaning inside values.

## 5. Semantics — Core profile

### 5.1 Comparators

#### 5.1.1 The Core comparator set

The canonical comparator vocabulary is deliberately small and orthogonal:

| Comparator | Meaning |
|---|---|
| `eq` | equality |
| `lt`, `le`, `gt`, `ge` | ordered comparison |
| `contains` | string substring / collection membership of the value in the property's value |
| `starts_with`, `ends_with` | string affix match |
| `in` | property value is a member of the given value list |

**Negation is uniform:** prefixing any Core comparator with `not_` yields its logical
complement over the collection (`tag=not_in=(a,b)`, `name=not_contains=xyz`,
`price=not_eq=10`). Negation is set complement: `not_lt` matches every resource `lt`
does not match, which is *not* equivalent to `ge` for resources where the property is
absent or incomparable.

There is exactly one equality (`eq`) and one negation mechanism (`not_`). Notions like
"strict vs. converting equality" are properties of the *value literal* (§5.2), not of
the comparator; forms like `!=`, `===`, `ne`, and `between` are surface sugar (§5.1.2)
or compatibility aliases (Appendix B).

#### 5.1.2 Symbolic operators and sugar (desugaring table)

| Surface form | Canonical form | Value interpretation (§5.2) |
|---|---|---|
| `prop=value` | `eq` | verbatim |
| `prop===value` | `eq` | verbatim |
| `prop==value` | `eq` | interpreted |
| `prop!=value` | `not_` `eq` | interpreted |
| `prop!==value` | `not_` `eq` | verbatim |
| `prop<v`, `prop<=v`, `prop>v`, `prop>=v` | `lt`, `le`, `gt`, `ge` | interpreted |
| `prop=name=value` (FIQL) | `name` | interpreted |
| `prop==stem*` | `starts_with` (trailing `*` removed) | interpreted |

The trailing-`*` wildcard applies only to `==`; a leading or embedded `*` is a syntax
error, and wildcards apply to no other comparator.

**Open vocabulary:** any syntactically valid `fiql-name` MUST parse; a name outside the
Core set (and not a registered Extension or alias) is rejected at execution, not at
parse. This is the language's comparator extension point.

**Value lists** `(v1,v2,…)` are interpreted as lists only for `in`/`not_in` (and the
`between` compatibility alias, Appendix B); each element is interpreted individually and
MAY be typed. `()` is the empty list.

### 5.2 Values

#### 5.2.1 Value model

RQL values are typed literals drawn from a language-neutral set: **string**, **number**,
**boolean**, **null**, **timestamp**, and **list** (for list-valued comparators). A
condition's value is fixed at parse time; comparators are agnostic to how the literal
was written.

A value token is read in one of two modes:

- **verbatim** — the token is the percent-decoded string, uninterpreted. Used by `=`,
  `===`, `!==`.
- **interpreted** — the token is converted by the literal rules below. Used by `==`,
  `!=`, symbolic ordered comparisons, and all FIQL named comparators.

When the target schema declares a type for the property, implementations MAY additionally
convert the parsed value to the schema type at binding time in either mode.

#### 5.2.2 Literal interpretation rules

| Token | Interpreted value |
|---|---|
| `null` | null |
| `true` / `false` | boolean, when the property is not schema-typed as string |
| decimal numeral | number, when the property is not schema-typed as string |
| `number:N` | number (decimal) |
| `number:$X` | number, `X` in base 36 |
| `boolean:true` / `boolean:false` | boolean |
| `date:ISO-8601` / `date:epochMillis` | timestamp |
| `string:S` | string (suppresses further interpretation) |
| any other token | percent-decoded string |
| unknown `type:` prefix | error (client error, HTTP 400) |

### 5.3 Element-scoped matching and range chaining

A condition on a list-valued property matches existentially — if **any** element
matches (§5.5). Because conjunction does not distribute over that quantifier, RQL
provides *element scoping*: a way to require that several comparisons hold for the
**same** element.

**Chaining** continues the preceding condition, scoped to the same element: `&=` (and)
or `|=` (or), each followed by a named comparison:

```
skiLengths=ge=175&=le=180       ; some ONE length is in [175, 180]
skiLengths=ge=175&skiLengths=le=180
                                ; DIFFERENT: some length ≥ 175 AND some
                                ; (possibly other) length ≤ 180
```

For the record `{ name: "Kris", skiLengths: [172, 174, 181] }`, the chained forms do
not match, while the two-condition form does (181 witnesses the first condition, 172
the second).

**Scoped sub-queries** generalize this to object elements: a property path directly
followed by a bracketed group scopes the whole group to one element, with inner paths
relative to that element:

```
skis[length=ge=175&width=le=80]   ; some ski is both long and narrow
```

Canonically both forms are an *element-scoped match* (§6): the path plus a group whose
conditions have element-relative paths (an empty relative path denotes the element
value itself, as chained scalar comparisons produce). For a single-valued property,
element scoping is trivially equivalent to separate conditions; parsers cannot know
value cardinality, so the scoping structure is always preserved. (Or-chaining is
logically distributable over the existential quantifier, but it is represented scoped
as well, for symmetry.)

Executors are encouraged to execute same-element `ge`/`gt` + `le`/`lt` pairs as a
single index range scan — for element-indexed lists that scan implements same-element
semantics naturally.

### 5.4 Logical composition and grouping

- `&` is conjunction, `|` is disjunction.
- Within one group nesting level, `&` and `|` MUST NOT be mixed; use `(...)` or `[...]`
  to disambiguate: `a=1&[b=2|c=3]`.
- `(...)` and `[...]` are semantically identical groupings (see §4.1 for why brackets are
  RECOMMENDED in generated queries).

### 5.5 Property paths

Dot syntax addresses nested properties: `brand.name=Microsoft`. Where the data model
declares relationships, path traversal crosses them; filtering through a relationship
has inner-join semantics, while projecting an unfiltered relationship via `select` has
left-join semantics. When a path traverses a list-valued property, a condition matches
if **any** element matches (existential semantics); to bind several comparisons to the
same element, use element scoping (§5.3).

Literal dots in property names are expressed with `%2E` (§4.2).

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
| `select(...)` | Projection (§5.7). |
| `sort(k1,k2,…)` | Each key optionally prefixed `+` (ascending, default) or `-` (descending); later keys break ties. Keys may be dotted paths. Note: some URL stacks decode a raw `+` as a space in query components; producers SHOULD percent-encode it (`%2B`) or rely on the ascending default. |
| `limit(end)` / `limit(start,end)` | **Start/end bounds, not offset/count**: `limit(5,10)` means offset 5, at most 5 records. |
| `group-by(...)` | Reserved. Parsers MUST accept the syntax; Core executors report "not implemented". |
| `(...)` (anonymous) | Grouping, §5.4. |

### 5.7 Projection (`select`)

Canonically a projection is a **mode** plus an ordered list of **fields**, each a
property path with an optional nested projection:

| Surface form | Mode | Meaning |
|---|---|---|
| `select(a)` | `values` | the result is the sequence of values of `a` |
| `select(a,b)` (or `select(a,)` for one field) | `records` | records trimmed to the listed fields |
| `select([a,b])` | `tuples` | each result row is the array `[a-value, b-value]` |
| `select(rel{x,y})` / `select(rel[select(x,y)])` | (nested) | field `rel` projected by the nested projection |

The brace and bracket nested forms are equivalent surface spellings of the same nested
projection.

## 6. Canonical parsed representation

The data model is defined abstractly; a binding in any language MUST preserve this
shape. (JSON is used below as notation, not as a required encoding.)

```
Query      := { filter?:  Group,
                sort?:    [ SortKey … ],
                select?:  Projection,
                limit?:   non-negative integer,
                offset?:  non-negative integer }

Group      := { operator: "and" | "or",
                terms:    [ (Condition | Group | ElementMatch) … ] }

Condition  := { path:       [ segment … ],       // one or more segments
                comparator: name,                // canonical, never an alias
                negated?:   boolean,
                value:      Value }

ElementMatch := { path:     [ segment … ],       // §5.3: ∃ value at path
                  negated?: boolean,             //        satisfying `some`
                  some:     Group }              // inner Condition paths are
                                                 // element-relative; [] = the
                                                 // element value itself

SortKey    := { path: [ segment … ], direction: "asc" | "desc" }

Projection := { mode: "records" | "values" | "tuples",
                fields: [ Field … ] }
Field      := { path: [ segment … ], projection?: Projection }

Value      := string | number | boolean | null | timestamp | [ Value … ]
```

Invariants:

- **All sugar is gone.** Aliases are resolved to canonical comparator names; `!=`
  desugars to `negated eq`; wildcards to `starts_with`; chaining and `between` to an
  ElementMatch; `prop[x=1]` with a single inner condition normalizes to the plain
  Condition `prop.x=1` (an ElementMatch always scopes two or more comparisons). Two
  surface queries with the same meaning parse to the same representation.
- **A condition's `path` is always a segment list**, even for a single segment.
- `filter` is absent for an unfiltered query; a query with a single condition is an
  `and` group with one term (there is no bare-condition special case).
- The representation carries no execution or host-framework concerns (no lazy/simple
  dual shapes, no linked lists, no URL-object inheritance). Hosts wanting such
  affordances build them *around* the model, not into it.

### 6.1 Error model

Structural syntax violations (unbalanced groups, illegal wildcard, unknown call
function, unknown `type:` prefix) are client errors (HTTP 400 in an HTTP binding).
Implementations MAY offer a deferred-error mode in which the parser returns a
representation carrying the error for the execution pipeline to raise, but the canonical
behavior is to reject at parse.

## 7. Serialization

Every Query has a canonical string form, defined so that `parse(serialize(q)) = q`:

- conditions in FIQL named form (`prop=eq=value`), canonical comparator names,
  `not_`-prefixed when negated;
- explicit `type:` prefixes whenever the interpreted reading of the emitted token would
  differ from the value's type;
- `[...]` for all grouping; `%2E` for literal dots in segments;
- element-scoped matches in chained form (`prop=ge=1&=le=5`) when every inner path is
  empty, and in scoped-sub-query form (`prop[…]`) otherwise;
- call functions last, in the order `select`, `sort`, `limit`.

TODO: full normalization rules (value-token escaping table, timestamp formatting,
ordering guarantees) — needed for cache keys and equivalence testing.

## 8. Conformance

- **Core parser:** implements §4–§6 exactly; validated by the conformance suite
  (`test/v2/` in the reference implementation), which is defined as surface-string →
  canonical-representation pairs and is therefore language- and implementation-neutral.
  An implementation with a different internal representation (e.g. Harper) conforms by
  supplying an adapter from its internal form to the canonical model.
- **Core executor:** implements Core comparator/call semantics over a collection.
- **Extensions (Appendix C):** optional; names are reserved and MUST NOT be repurposed.
- **Compatibility aliases (Appendix B):** optional; if accepted, they MUST desugar
  exactly as specified.

## 9. Security considerations

TODO: complexity/DoS bounds (nesting depth, condition count, value-list length),
percent-decoding pitfalls, injection via property paths into schema-less stores,
regex-free matching guarantees.

---

## Appendix A — Breaking changes from RQL 1.x (migration)

| Area | RQL 1.x | RQL 2.0 |
|---|---|---|
| Operator model | one category: call form `op(args)` is the normalized form of everything; infix is sugar | two disjoint categories: infix-only comparators (open set, execution-validated) vs. call-only result-shaping functions (closed set, parse-validated) |
| `lt(price,10)` etc. | valid, ≡ `price=lt=10` | parse error — comparators have no call form |
| `prop=value` | interpreted `eq` | **verbatim** `eq`; use `==` for interpretation |
| `limit` | `limit(count,start,maxCount)` | `limit(end)` / `limit(start,end)` |
| Nested paths | `foo/bar`, `(foo,bar)` | `foo.bar` |
| Grouping | `(...)` only | `(...)` and `[...]` |
| String matching | `re:`/`RE:`/`glob:` converters, `match` | `contains`/`starts_with`/`ends_with`, `==stem*` |
| Converters | `epoch:`, `isodate:`, `re:`, `glob:` | removed; `date:` accepts ISO-8601 or epoch ms |
| Positional params | `$1`, `$2` | removed |
| Negation | none | uniform `not_` comparator prefix |
| Range expression | `between` operator | `&=` / `|=` chaining (canonical); `between` demoted to alias |
| Sub-selects | none | `rel{x,y}`, `rel[select(x)]`, `select([a,b])` |
| AST | generic `{name, args}` term tree | typed canonical model (§6); generic terms remain a non-normative encoding for Extensions |
| Aggregation etc. | Core operators | moved to Extensions profile (Appendix C) |

## Appendix B — Compatibility aliases (non-normative surface, normative desugaring)

Implementations MAY accept these for FIQL/1.x/Harper-lineage compatibility. If accepted,
they MUST desugar exactly as follows and MUST NOT appear in the canonical representation
or in canonical serialization:

| Alias | Desugars to |
|---|---|
| `ne` | `not_` `eq` (interpreted value) |
| `not_equal`, `equals` | `not_` `eq` / `eq` (verbatim value) |
| `between=(lo,hi)` | element-scoped `ge=lo` AND `le=hi` (≡ `=ge=lo&=le=hi`, inclusive; same-element per §5.3) |
| `not_between=(lo,hi)` | negation of the above |
| `sw`, `ew`, `ct`, `includes` | `starts_with`, `ends_with`, `contains`, `contains` |
| `less_than`, `greater_than`, `lessThan`, `greaterThan`, … | `lt`, `gt`, … |
| `out` (1.x) | `not_in` |
| repeated array parameters `prop[]=v1&prop[]=v2` | membership conditions on `prop` (host-framework accommodation; NOT part of the RQL grammar) |

## Appendix C — Extensions profile (reserved from 1.x)

Reserved call-function names carried from RQL 1.x, non-normative pending a future
revision: `aggregate`, `distinct`, `values`, `sum`, `mean`, `max`, `min`, `count`,
`first`, `one`, `recurse`, `rel`, `group-by`.

## Appendix D — Known divergences of the Harper implementation

Tracked so the spec stays ideal while implementations converge. As of harper `main`
(2026-08):

| # | Divergence | Spec position |
|---|---|---|
| 1 | Simple queries (no structural characters) skip parsing and surface as raw name/value pairs; consumers handle two condition shapes | §6: one canonical shape; lazy representations are a host affordance outside the model |
| 2 | `&=`/`|=` chains attach to the prior condition as `chainedConditions`; a nameless chain leg (`a=ge=1&=5`) is accepted and inherits the previous leg's comparator | semantically correct (same-element scoping, §5.3); representational divergence only — canonical form is ElementMatch. Nameless legs are a syntax error in 2.0 (the comparator name is required) |
| 3 | Strict vs. converting comparison is modeled as distinct comparators (`equals`/`not_equal` vs `eq`/`ne`) | §5.2: one `eq`; verbatim vs. interpreted is a property of the value literal |
| 4 | `between` is a first-class comparator | Appendix B alias, desugars to `ge`+`le` |
| 5 | Sort is a linked list; select is a polymorphic array with marker properties (`asArray`, `name`) | §6: sort is an ordered list of SortKeys; projection is mode + fields |
| 6 | `(4)` on a non-list comparator is the literal string `"(4)"` | tolerance only; producers MUST NOT rely on it |
| 7 | `prop[]=v` repeated-array params accepted in the parser | Appendix B host accommodation, not grammar |
| 8 | Unknown call-name error and other semantic errors are deferred into the request pipeline (`parseError`) | §6.1: deferred mode is OPTIONAL; canonical behavior rejects at parse |
| 9 | `group-by(...)` fell through into `sort` handling (missing `break`) | bug; fix in flight (harper dispatch `harper-groupby-fallthrough`) |
