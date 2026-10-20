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
toward it, tracking their own divergences in public ledgers (linked from Appendix D)
rather than having them normalized into the language. The specification is language-neutral: the canonical parsed representation
(§6) is an abstract data model, intended to support reference implementations in multiple
programming languages.

RQL 2.0 consists of:

- a **surface grammar** (§4) for conditions, logical composition, and call-style query
  functions, designed to be a compatible superset of HTML form URL encoding and of FIQL;
- **operator semantics** (§5): a small orthogonal comparator set with uniform negation,
  typed value literals, element-scoped matching and range chaining, property paths, and
  the `select`/`sort`/`limit` functions;
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
6. **Language-neutral and schema-free.** The canonical representation is defined
   abstractly and is fully determined by the query string alone — no schema participates
   in parsing (§5.2). Bindings for particular languages map the model to native
   structures but MUST preserve its shape.

## 4. Grammar

ABNF (RFC 5234), with the tokenization rules below.

```abnf
query          = [ q-term *( conjunction q-term ) ]
q-term         = term / call
               ; call functions MAY appear only at the top level, and the
               ; conjunction adjacent to a call MUST be "&"
conjunction    = "&" / "|"
term           = condition / chained-cond / group / scoped-match / not-expr
group          = "(" group-body ")" / "[" group-body "]"
not-expr       = "not" "(" group-body ")"
               ; logical negation of the body (§5.4); a term form, NOT a call
               ; function — "not" followed by "(" is recognized as negation in
               ; every term position, including the top level
group-body     = term *( conjunction term )
               ; all conjunctions within one group-body MUST be identical (§5.4)
scoped-match   = prop-path "[" scoped-body "]"
               ; element-scoped sub-query over the values at prop-path (§5.3);
               ; inner prop-paths are element-relative
scoped-body    = scoped-term *( conjunction scoped-term )
scoped-term    = term / elem-cond
elem-cond      = "=" fiql-name "=" ( value / value-list )
               ; a comparison on the scoped element itself (empty relative path);
               ; valid only inside a scoped-match

condition      = prop-path symbol-op value
               / prop-path "=" fiql-name "=" ( value / value-list )
chained-cond   = ( "&=" / "|=" ) fiql-name "=" ( value / value-list )
               ; continues the immediately preceding condition, scoped to the
               ; same element (§5.3); MUST directly follow a condition or
               ; another chained-cond

symbol-op      = "=" / "==" / "===" / "!=" / "!==" / "<" / "<=" / ">" / ">="
fiql-name      = ALPHA-UNDER *( ALPHA-UNDER / DIGIT )
ALPHA-UNDER    = ALPHA / "_"

prop-path      = prop-segment *( "." prop-segment )
prop-segment   = 1*seg-char
seg-char       = ALPHA / DIGIT / "-" / "_" / "~" / pct-encoded
               ; any other character — including a literal "." (§4.2) — is
               ; included via percent-encoding
pct-encoded    = "%" HEXDIG HEXDIG

value          = plain-value / typed-value / wildcard-value
plain-value    = *vchar
typed-value    = type-name ":" *vchar           ; §5.2.2
type-name      = fiql-name
wildcard-value = *vchar "*"                     ; "*" only as the final
                                                ; character, only with "==" (§5.1.2)
value-list     = "(" [ value *( "," value ) ] ")"
vchar          = seg-char / ":" / "*" / "+" / "$" / "@" / "!" / "'"
               ; pragmatically: any character other than the structural
               ; delimiters & | = , ( ) [ ] { } — those are included via
               ; percent-encoding

call           = call-name "(" [ call-args ] ")"
call-name      = 1*( ALPHA / DIGIT / "-" / "_" )
call-args      = call-arg *( "," call-arg ) [ "," ]
               ; the trailing comma is significant only for select (§5.7)
call-arg       = value / sort-key / select-item
sort-key       = [ "+" / "-" ] prop-path
select-item    = prop-path
               / prop-path "{" select-list "}"                    ; nested projection
               / prop-path "[" "select" "(" select-list ")" "]"   ; equivalent bracket form
               / "[" select-list "]"                              ; tuple-shaped rows
select-list    = select-item *( "," select-item )
```

**Tokenization rules.** The grammar above is ambiguous as pure ABNF (`plain-value`
overlaps other productions); the following rules resolve it deterministically:

1. **Longest match.** Multi-character tokens win over their prefixes: `&=`/`|=` are
   recognized before `&`/`|`; `<=`, `>=`, `==`, `===`, `!=`, `!==` before `<`, `>`,
   `=`, `!`.
2. **A raw `=` never occurs inside a value.** Value scanning stops at the structural
   delimiters, so a `=` following a value token can only begin a `chained-cond` or the
   second `=` of a FIQL form.
3. **A `chained-cond` binds to its predecessor.** It is valid only immediately after a
   `condition` or another `chained-cond`; anywhere else it is a syntax error.
4. **Semantic markers are recognized on raw tokens** — see §4.2 rule 4.

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
4. **Semantic markers are recognized on the raw token, before decoding:** the
   `type:` prefix of a typed value, the trailing `*` wildcard, and the `+`/`-`
   sort-direction prefix. A percent-encoded form of a marker character is therefore
   literal content, never a marker: `x==string%3Anull` is the plain string
   `string:null` (not a typed literal), `name==Jo%2A` is an equality against `Jo*`
   (not a wildcard), and `sort(%2Bname)` sorts by the property named `+name`.

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
| `contains` | string containment: the property's string value contains the given substring |
| `starts_with`, `ends_with` | string affix match |
| `in` | the property's value equals a member of the given value list |

**Comparators are scalar predicates.** Every comparator applies to a single value; when
a path reaches a list, the existential traversal rule (§5.5) — never the comparator —
handles the elements. Over `tags: ["credit"]`, `tags=contains=red` matches (some element
contains the substring `red`), and whole-element equality is simply `tags=credit`. The
string comparators (`contains`, `starts_with`, `ends_with`) match only string values; a
non-string value does not match them.

**Negation is uniform and scopes over the condition's own traversal.** Prefixing any
Core comparator with `not_` complements the set the un-negated condition matches, *at
the scope where the condition is evaluated*:

- For a top-level condition whose path traverses a list, negation scopes over the
  existential: `tags=not_eq=urgent` means ¬∃ — it matches only records where **no** tag
  equals `urgent` (over `tags: ["urgent", "low"]` it does not match).
- Within an element scope (§5.3), the enclosing scope supplies the quantifier, so a
  negated inner comparison negates the predicate on the bound element:
  `ratings=ge=3&=not_eq=4` means ∃x: x ≥ 3 ∧ x ≠ 4. Recursively, an inner condition
  whose *relative* path traverses a nested list scopes its own negation the same way.
- The complementary reading ∃x: ¬P(x) ("some element differs") is written as an explicit
  singleton scope: `tags[=not_eq=urgent]`.

As a consequence of complement semantics, `not_lt` matches every resource `lt` does not
match — which is *not* equivalent to `ge` for resources where the property is absent or
incomparable. Entire groups and scopes are negated with `not(...)` (§5.4), which
desugars to these leaf and scope negations.

There is exactly one equality (`eq`) and one negation mechanism (`not_`). Notions like
"strict vs. converting equality" are properties of the *value literal* (§5.2), not of
the comparator; forms like `!=`, `===`, `ne`, and `between` are surface sugar (§5.1.2)
or compatibility aliases (Appendix B).

#### 5.1.2 Symbolic operators and sugar (desugaring table)

| Surface form | Canonical form | Value handling (§5.2) |
|---|---|---|
| `prop=value` | `eq` | verbatim |
| `prop===value` | `eq` | verbatim |
| `prop==value` | `eq` | interpreted |
| `prop!=value` | `not_` `eq` | interpreted |
| `prop!==value` | `not_` `eq` | verbatim |
| `prop<v`, `prop<=v`, `prop>v`, `prop>=v` | `lt`, `le`, `gt`, `ge` | interpreted |
| `prop=name=value` (FIQL) | `name` | interpreted |
| `prop==stem*` | `starts_with` (trailing `*` removed) | the stem is the **decoded string**, never an interpreted literal (`name==12*` matches strings starting `12`) |

The trailing-`*` wildcard applies only to `==`; a leading or embedded `*` is a syntax
error, and wildcards apply to no other comparator.

**Open vocabulary:** any syntactically valid `fiql-name` MUST parse; a name outside the
Core set (and not a registered Extension or alias) is rejected at execution, not at
parse. This is the language's comparator extension point.

**Value lists** `(v1,v2,…)` are interpreted as lists only for `in`/`not_in` (and the
`between` compatibility alias, Appendix B), including in chained legs; each element is
interpreted individually and MAY be typed. `()` is the empty list. A value list supplied
to any other comparator is a syntax error.

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

**Interpretation is schema-free.** The canonical representation of a query is fully
determined by the query string alone; the conformance suite (§8) depends on this.
Binding parsed values to a typed store — converting the string `"3"` to the number 3
for a numeric column, or 3 to `"3"` for a string column — is an execution-time concern
outside the canonical model, applicable in either mode.

#### 5.2.2 Literal interpretation rules

| Token | Interpreted value |
|---|---|
| `null` | null |
| `true` / `false` | boolean |
| round-trip decimal numeral | number — a token that equals the canonical decimal rendering of the number it denotes (`3`, `-5`, `2.5`); non-round-trip numeric spellings (`1e3`, `01`, `.5`, `1.50`) remain strings |
| `number:N` | number (decimal) |
| `number:$X` | number, `X` in base 36 |
| `boolean:true` / `boolean:false` | boolean |
| `date:ISO-8601` / `date:epochMillis` | timestamp |
| `string:S` | string (suppresses further interpretation) |
| any other token | percent-decoded string |
| unknown `type:` prefix | syntax error (client error, HTTP 400) |
| malformed typed literal (`boolean:yes`, `number:abc`, unparseable `date:`) | syntax error (client error, HTTP 400) |

### 5.3 Element-scoped matching and range chaining

A condition on a list-valued property matches existentially — if **any** element
matches (§5.5). Because conjunction does not distribute over that quantifier, RQL
provides *element scoping*: a way to require that several comparisons hold for the
**same** element.

**Chaining** continues the preceding condition, scoped to the same element: `&=` (and)
or `|=` (or), each followed by a named comparison:

```
ratings=ge=3&=le=4          ; some ONE rating is in [3, 4]
ratings=ge=3&ratings=le=4   ; DIFFERENT: some rating ≥ 3 AND some
                            ; (possibly other) rating ≤ 4
```

For the record `{ sku: "widget-1", ratings: [2, 3, 5] }` the two-condition form matches
(5 witnesses the first condition, 2 the second)… while `ratings=ge=4&=le=4` over the
same record does not match and `ratings=ge=3&=le=4` matches only via the element 3.

**Scoped sub-queries** generalize this to object elements: a property path directly
followed by a bracketed group scopes the whole group to one element, with inner paths
relative to that element. An inner comparison on the element value itself is written
with no property path (`elem-cond`):

```
reviews[rating=ge=4&helpful=ge=10]   ; some review is both high-rated and helpful
scores[=ge=10|=le=2]                 ; some score is an outlier (≥10 or ≤2)
tags[=not_eq=urgent]                 ; some tag differs from "urgent" (∃¬ — contrast
                                     ; tags=not_eq=urgent, ¬∃, §5.1.1)
```

Canonically all of these are an *element-scoped match* (§6): the path plus a group whose
conditions have element-relative paths (an empty relative path denotes the element
value itself, as chained scalar comparisons produce). For a single-valued property,
element scoping is trivially equivalent to separate conditions; parsers cannot know
value cardinality, so the scoping structure is preserved. (Or-chaining is logically
distributable over the existential quantifier, but it is represented scoped as well,
for symmetry.)

A non-negated scoped match containing exactly one **non-negated** inner condition is
equivalent to a plain condition on the concatenated path and normalizes to it:
`orders[status=open]` ≡ `orders.status=open`, and likewise for an element condition —
`scores[=ge=10]` ≡ `scores=ge=10` (a plain condition on a list path is already
existential). A **negated** inner condition (or a negated scope) is *not* flattened —
under §5.1.1's scope rule, `tags[=not_eq=urgent]` (∃¬) and `tags=not_eq=urgent` (¬∃)
mean different things.

Executors are encouraged to execute same-element `ge`/`gt` + `le`/`lt` pairs as a
single index range scan — for element-indexed lists that scan implements same-element
semantics naturally.

### 5.4 Logical composition and grouping

- `&` is conjunction, `|` is disjunction.
- Within one group nesting level, `&` and `|` MUST NOT be mixed; use `(...)` or `[...]`
  to disambiguate: `a=1&[b=2|c=3]`.
- `(...)` and `[...]` are semantically identical groupings (see §4.1 for why brackets are
  RECOMMENDED in generated queries).

**Negation of a group or scope.** `not(body)` complements the match of its body and may
appear wherever a term may:

```
status=open&not(tag=urgent|tag=blocked)
not(scores[=ge=10&=le=20])        ; NO element is in [10, 20]
```

`not(...)` is pure sugar: parsers MUST desugar it by pushing negation inward, which is
exactly meaning-preserving because negation is set complement (§5.1.1):

- `not(` condition `)` toggles the condition's `negated` flag (≡ the `not_` prefix);
- `not(` and-group `)` becomes the or-group of the negated terms, and vice versa
  (De Morgan, applied recursively);
- `not(` scoped-match `)` toggles the ElementMatch's `negated` flag;
- nested `not` cancels.

Consequently `not` never appears in the canonical representation (§6) or in canonical
serialization (§7) except as the spelling of a negated ElementMatch.

### 5.5 Property paths

Dot syntax addresses nested properties: `brand.name=Microsoft`. Where the data model
declares relationships, path traversal crosses them; filtering through a relationship
has inner-join semantics, while projecting an unfiltered relationship via `select` has
left-join semantics.

When a path traverses a list-valued property, a condition matches if **any** element
matches (existential semantics); to bind several comparisons to the same element, use
element scoping (§5.3). **Matching determines membership, not multiplicity:** a query
yields each matching record at most once, no matter how many elements (or how many
conditions) witness the match.

Literal dots in property names are expressed with `%2E` (§4.2).

### 5.6 Call functions

Exactly these call functions are Core. An unrecognized call name — including the
reserved Extension names of Appendix C — is a parse error (unlike comparator names,
which are open). A call function appearing more than once in a query is a syntax error.
`not(...)` (§5.4) is not a call function: it is a term-position logical form, and its
name is excluded from the call-function namespace.

> **Break from 1.x:** in RQL 1.x, call syntax was the *normalized form* of every
> operator — `lt(price,10)` was equivalent to `price=lt=10`, and infix forms were sugar.
> In 2.0 the categories are disjoint: comparators are infix-only with an open name set
> (§5.1.2), and call syntax is reserved for this closed set of result-shaping functions.
> `lt(price,10)` is a parse error. The anonymous group `(...)` (§5.4) is the one place
> call syntax still yields conditions.

| Function | Semantics |
|---|---|
| `select(...)` | Projection (§5.7). |
| `sort(k1,k2,…)` | Each key optionally prefixed `+` (ascending, default) or `-` (descending); later keys break ties. Keys may be dotted paths. The prefix is recognized on the raw token (§4.2): `%2B`/`%2D` are literal name characters, not direction markers. Since some URL stacks decode a raw `+` as a space, producers SHOULD rely on the ascending default rather than writing `+`. |
| `limit(end)` / `limit(start,end)` | **Start/end bounds, not offset/count**: `limit(5,10)` means offset 5, at most 5 records. Arguments MUST be non-negative decimal integers with end ≥ start; anything else is a syntax error. |
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
projection. **Nested projections are always `records` mode** — `rel{x}` trims the
related object to `{x}`; the single-field `values` rule applies only at the top level.
A nested `[x,y]` tuple form (`rel{[x,y]}`) is reserved and currently a syntax error.

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
  ElementMatch; `not(...)` desugars into leaf/scope negation flags (§5.4). A non-negated
  scoped match with a single non-negated inner condition normalizes to the plain
  Condition on the concatenated path (`prop[x=1]` ≡ `prop.x=1`, `prop[=ge=10]` ≡
  `prop=ge=10`); a negated inner condition or scope is never flattened (§5.3).
- **Desugaring is deterministic:** equivalent sugar forms (aliases, `between` vs.
  chaining, `!=` vs. `ne`) parse to identical representations. Full semantic
  canonicalization — group flattening, term reordering — is the province of §7
  serialization and is NOT asserted here: `a=1` and `(a=1)` may differ
  representationally.
- **A condition's `path` is always a segment list**, even for a single segment.
- Every value in the model is a well-formed member of `Value` — no NaN, no invalid
  timestamps (§5.2.2 makes malformed literals syntax errors), and `limit`/`offset` are
  validated non-negative integers (§5.6).
- `filter` is absent for an unfiltered query; a query with a single condition is an
  `and` group with one term (there is no bare-condition special case).
- The representation carries no execution or host-framework concerns (no lazy/simple
  dual shapes, no linked lists, no URL-object inheritance). Hosts wanting such
  affordances build them *around* the model, not into it.

### 6.1 Error model

Structural syntax violations (unbalanced groups, illegal wildcard, unknown or duplicate
call function, unknown `type:` prefix, malformed typed or numeric literal, out-of-range
`limit` arguments) are client errors (HTTP 400 in an HTTP binding). Implementations MAY
offer a deferred-error mode in which the parser returns a representation carrying the
error for the execution pipeline to raise, but the canonical behavior is to reject at
parse.

## 7. Serialization

Every Query has a canonical string form, defined so that `parse(serialize(q)) = q`:

- conditions in FIQL named form (`prop=eq=value`), canonical comparator names,
  `not_`-prefixed when negated;
- explicit `type:` prefixes whenever the interpreted reading of the emitted token would
  differ from the value's type;
- `[...]` for all grouping; `%2E` for literal dots in segments;
- element-scoped matches in chained form (`prop=ge=1&=le=5`) when every inner path is
  empty and the scope is not negated, in scoped-sub-query form (`prop[…]`) otherwise,
  and negated scopes as `not(prop[…])`;
- call functions last, in the order `select`, `sort`, `limit`.

TODO: full normalization rules (value-token escaping table, timestamp formatting,
ordering guarantees) — needed for cache keys and equivalence testing.

## 8. Conformance

- **Core parser:** implements §4–§6 exactly; validated by the conformance suite
  (`test/v2/` in the reference implementation), which is defined as **schema-free**
  surface-string → canonical-representation pairs and is therefore language- and
  implementation-neutral. An implementation with a different internal representation
  (e.g. Harper) conforms by supplying an adapter from its internal form to the
  canonical model.
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
| Converters | open, extensible registry (`epoch:`, `isodate:`, `re:`, `glob:`, custom) | closed typed-prefix set (`number:`, `boolean:`, `date:`, `string:`); unknown or malformed prefix is a syntax error |
| Positional params | `$1`, `$2` | removed |
| Negation | none | uniform `not_` comparator prefix scoping over the condition's own traversal (§5.1.1), plus `not(...)` group/scope negation (§5.4) |
| Range expression | `between` operator | `&=` / `|=` chaining (canonical); `between` demoted to alias |
| Collection matching | query-valued `contains(items,gt(price,10))`, `excludes(items,red)`; nested-array/condition arguments in value lists | scoped matches: `items[price=gt=10]`; membership is plain traversal (`items=red`); exclusion is `not_` (`items=not_eq=red`); value lists hold only literals |
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
| `not_between=(lo,hi)` | negation of the above (negated ElementMatch) |
| `sw`, `ew`, `ct`, `includes` | `starts_with`, `ends_with`, `contains`, `contains` |
| `less_than`, `greater_than`, `lessThan`, `greaterThan`, … | `lt`, `gt`, … |
| `out` (1.x) | `not_in` |
| repeated array parameters `prop[]=v1&prop[]=v2` | membership conditions on `prop` (host-framework accommodation; NOT part of the RQL grammar) |

## Appendix C — Extensions profile (reserved names)

Reserved call-function names, non-normative pending a future revision — carried from
RQL 1.x: `aggregate`, `distinct`, `values`, `sum`, `mean`, `max`, `min`, `count`,
`first`, `one`, `recurse`, `rel`, `group-by`. Core parsers reject these as unknown call
functions (§5.6). (`not` is not on this list — it is a Core term form, §5.4.)

## Appendix D — Implementation divergence tracking

This specification is implementation-independent; it does not track any vendor's bugs
or gaps. An implementation converges by maintaining its own public divergence ledger —
each entry naming the deviating behavior, its class (bug, feature gap, or permitted
representational difference per §8's adapter rule), and the spec clause it converges
to.

Known ledgers:

- **Harper** — [HarperFast/harper#2440](https://github.com/HarperFast/harper/issues/2440)

## Appendix E — Hosting other dialects: PostgREST (non-normative)

[PostgREST](https://docs.postgrest.org/) exposes a URL filter syntax over PostgreSQL
that solves the same problem as RQL and arrives at a different surface. This appendix
maps it onto the canonical model (§6). Nothing here is normative: it is included as
evidence that the canonical representation is dialect-neutral, and as guidance for
implementations that want to accept a second surface syntax — a conforming parser MAY
offer additional surfaces so long as each desugars into the same model.

### E.1 Why the surfaces do not converge

PostgREST's syntax is a transcription of PostgreSQL's operator set into URL space; RQL's
is a store-neutral language. The differences are foundational, not cosmetic:

| | PostgREST | RQL 2.0 |
|---|---|---|
| Operator position | inside the value, dot-separated — `?age=gte.18` | operator position — `age=ge=18` |
| Bare `?a=b` | invalid; an operator is required | valid, `eq` with a verbatim value (§3.2) |
| Operator names | transcribe PostgreSQL (`gte`, `neq`, `cs`, `ov`, `wfts`) | store-neutral (`ge`, `not_eq`, `contains`, `in`) |
| Logical composition | prefix trees — `?or=(a.eq.1,and(b.eq.2,c.eq.3))` | infix — `a=1|[b=2&c=3]` |
| Type handling | schema/SQL-typed, tri-state `NULL` | schema-free literals (§5.2), set semantics |

The dot is the decisive collision: PostgREST spends it on the operator separator, RQL on
property paths (`brand.name=x`). Neither can adopt the other's spelling without losing
its own.

### E.2 Operator mapping

| PostgREST | Canonical RQL form |
|---|---|
| `eq`, `gt`, `gte`, `lt`, `lte` | `eq`, `gt`, `ge`, `lt`, `le` |
| `neq` | `eq` with `negated` |
| `in.(a,b)` | `in` with a value list |
| `not.<op>` | the `not_` prefix — i.e. the same `negated` flag (§5.1.1) |
| `not.and=(…)`, `not.or=(…)` | `not(...)` (§5.4) — both designs negate operators *and* trees |
| `or=(…)`, `and=(…)` | `Group` with `operator: "or"` / `"and"` |
| `<op>(any).{a,b}` | an `or` group of one condition per value (`eq(any)` collapses to `in`) |
| `<op>(all).{a,b}` | an `and` group of one condition per value |
| `cs.{a,b}` (array contains all) | `and` group of existential `eq` conditions on the array path (§5.5) |
| `ov.{a,b}` (array overlap) | `in` |
| `cd.{a,b,c}` (array contained in) | `not(path[=not_in=(a,b,c)])` — ∀ as ¬∃¬ (§5.4) |
| `is.null` | `eq` with a `null` value (see E.4 on tri-state differences) |
| `like`, `ilike`, `match`, `imatch`, `fts`/`plfts`/`phfts`/`wfts` | not Core — Core is regex-free by design. Available as **extension comparators**: §5.1.2's open vocabulary lets a host accept these names and remain conformant. PostgREST's `*`-for-`%` alias parallels RQL's `==stem*` wildcard (§5.1.2) |
| `sl`, `sr`, `nxl`, `nxr`, `adj` (range operators) | not Core; extension comparators over a range-typed value |
| `isdistinct` | extension comparator (SQL `IS DISTINCT FROM`); see E.4 |
| `select=col`, `order=col.desc`, `limit`/`offset` | `select(col)`, `sort(-col)`, `limit(start,end)` |
| `json_col->>field` | a dotted path segment (`json_col.field`) |

Every filter operator above either maps into the Core model or is expressible as an
extension comparator, and both dialects' logical layers are the same `Group` tree in
different notation.

### E.3 Features RQL 2.0 lacks

Honest gaps, recorded rather than mapped away:

- **Projection aliasing and casting** — `select=alias:column`, `select=column::text`.
  RQL's `Projection` has no rename or cast; a future revision could add an optional
  `as`/`cast` to `Field`.
- **Null ordering** — `order=age.nullsfirst`. `SortKey` (§6) has no nulls placement;
  reserved for a future revision.
- **Aggregates in projections** — `select=amount.sum()`; RQL keeps aggregation in the
  Extensions profile (Appendix C).
- **Resource embedding** — PostgREST's `select=…,other_table(…)` with `!inner`/`!left`
  hints is richer than RQL's nested projection (§5.7), which fixes join semantics by
  position (filtering a path is inner, projecting it is left; §5.5).
- **Full-text search and range operators** — deliberately out of Core; extension
  comparators only.

### E.4 Semantic deltas to preserve deliberately

- **Embedded-filter defaults.** In PostgREST, filtering an embedded resource narrows the
  embedded rows and keeps the parent row (unless `!inner` is given). In RQL, a filter on
  a relationship path is inner-join semantics on the parent. A dialect front-end MUST
  therefore translate a PostgREST embedded filter into whichever RQL form matches the
  caller's intent; the two defaults are not interchangeable.
- **Null tri-state.** PostgREST inherits SQL's three-valued logic (`is.null`,
  `is.unknown`, `isdistinct`). RQL comparators are set predicates over a schema-free
  model: `path=not_eq=v` matches every record the un-negated condition does not
  (§5.1.1), including records where the property is absent — which is *not* SQL's
  `<> v`. Hosts backed by SQL should map RQL negation to `IS DISTINCT FROM`, not to
  `<>`, to preserve RQL's semantics.
- **Quantifier scope.** PostgREST's `any`/`all` modifiers quantify over the *value
  list*; RQL's element scoping (§5.3) quantifies over the *property's elements*. Both
  exist, and they are orthogonal — `path[=ge=1&=le=5]` has no PostgREST equivalent
  short of a database view.

### E.5 Practical use

Two applications follow from the mapping:

1. **A dialect front-end.** A parser can accept the PostgREST surface and emit the
   canonical model, so one execution engine serves both syntaxes and the conformance
   suite gains a second dialect's worth of vectors.
2. **Client-ecosystem compatibility.** A host that accepts the PostgREST surface becomes
   reachable by clients written against it. That is a product decision for the host, not
   a requirement of this specification.
