# ADR 0034: Money Representation And Arithmetic

## Status

Accepted architecture, recorded for [#9366](https://github.com/chase-sets/chase-sets/issues/9366)
under [#3579](https://github.com/chase-sets/chase-sets/issues/3579).
Executable examples were inspected at `43d1c2614507b965089a649bf6e94831f417003e`.
Linked issue statuses below were inspected on 2026-10-12.
Prescribed rules are distinguished from executable behavior and retained exceptions.
This record ships no implementation, guard, schema change, or migration.

## Context

- The canonical representation for amounts in code, API payloads and events is a
  decimal string. [The money primitive](../../contracts/primitives/money.ts)
  defines `MoneyAmount` and `SignedMoneyAmount`, normalization and validation,
  and a maximum magnitude of `9999999999.99` (`999999999999` cents).
  Canonical output has exactly two fractional digits; signed amounts permit
  negative values where the domain requires them.
- Executable arithmetic in [that module](../../contracts/primitives/money.ts)
  uses bigint cents for addition, subtraction, sums and comparisons. It provides
  `applyBasisPointsToMoneyAmount`, `grossUpMoneyAmountByBasisPoints`,
  `applyMoneyRatio` with explicit `ceil`, `floor` or `nearest` rounding, and
  `allocateMoneyByLargestRemainder`. This is an existing implementation, not a
  request for another money library.
- Existing storage uses decimal SQL columns: examples are `numeric(12,2)` in
  [Payments' schema](../../bounded-contexts/payments/features/payments/read-model/schema.ts),
  `numeric(14,2)` in [operations insights](../../bounded-contexts/platform-operations/features/insights-dashboards/read-model/ops-schema.ts),
  and `numeric(18,2)` in [liability reconciliation](../../bounded-contexts/settlement/features/liability-reconciliation/read-model/liability-reconciliation.ts).
  [Payments' queries](../../bounded-contexts/payments/features/payments/read-model/queries.ts)
  read amounts with `::text`, preserving the decimal-string boundary.
- Integral storage also exists: `postage_amount_cents integer` in
  [Fulfillment](../../bounded-contexts/fulfillment/features/shipments/read-model/schema.ts)
  and `price_amount_minor bigint` in
  [Channels' TCGplayer schema](../../bounded-contexts/channels/features/tcgplayer-csv/read-model/schema.ts).
- Display uses [formatMoney](../../contracts/localization/money.ts), which builds
  the amount from the decimal string without a float round-trip. Its fixed
  `Intl.NumberFormat` probe supplies currency placement and separators, not the
  actual amount's magnitude.
- Stripe takes integral minor units at the provider boundary, translated by
  [stripe-payments](../../infrastructure/stripe-payments/index.ts) and
  [stripe-connect](../../infrastructure/stripe-connect/index.ts). Their current
  `moneyToMinorUnits` helpers still use float parsing and rounding; the exact
  primitive does not imply every adapter already uses it.
- Payments currently supports USD only, enforced by
  [normalizeCurrencyCode](../../bounded-contexts/payments/support/runtime-support/common.ts).
  [The money primitive](../../contracts/primitives/money.ts) assumes two decimal
  places and carries no currency exponent.

The representation and validator ownership were decided in
[#3564](https://github.com/chase-sets/chase-sets/issues/3564) and
[#3704](https://github.com/chase-sets/chase-sets/issues/3704). This ADR records those
decisions rather than reopening them. The rules below prescribe new work; the
executable examples do not assert repository-wide convergence.

## Decision

### 1. Canonical Decimal Strings

Use canonical decimal strings for amounts in code, API payloads and events,
validated and normalized by `@chase-sets/primitives/money`. Use `MoneyAmount` for
non-negative amounts and `SignedMoneyAmount` for signed amounts. Do not duplicate
the primitive's parser, validator, range or canonicalization rules.

### 2. Exact Arithmetic And Explicit Rounding

Prescribed: route money arithmetic through `@chase-sets/primitives/money`, using
bigint cents and an explicit rounding mode whenever an operation can produce a
fractional cent. Choose `ceil`, `floor` or `nearest` from the domain rule, not a
generic rounding-at-the-edge convention. Addition, subtraction and comparison
are already exact and need no rounding choice.

New code must never hold an amount in a JavaScript number that is later persisted,
charged, paid out or compared against an authoritative limit. Number-typed market
estimates and pricing recommendations convert to canonical money at the persisted
boundary; an estimate is not an authoritative amount before that conversion.
This prescription is not a claim that the retained paths below, or every existing
provider adapter, already follow it.

### 3. Basis Points For New Money Percentages

Prescribed: represent new money percentages as basis points and use the primitive's
percentage helpers with explicit rounding. Existing fee policy already uses this
shape, for example
[Payments' checkout-fee policy](../../bounded-contexts/payments/features/payments/api/marketplace-checkout-fee-policy.ts).
This does not quantize an existing policy value or authorize a stored-value migration.

### 3a. Retained Executable Exceptions

- Ordering's [shipping quote policy](../../bounded-contexts/ordering/features/orders/domain/policies.ts)
  sums number constants and converts through
  [numberToMoneyAmount](../../bounded-contexts/ordering/features/orders/domain/common.ts),
  whose `toFixed(6)` path converts to bigint before rounding cents. This path is
  retained, not debt to fix: it is exact for its inputs. The
  [#9366 brief](https://github.com/chase-sets/chase-sets/issues/9366) reports zero
  mismatches over about 990,000 fuzzed quotes; this ADR does not claim a new fuzz run.
- The [platform remedy policy](../../bounded-contexts/platform-operations/features/support-requests/domain/platform-remedy-policy.ts)
  retains its stored decimal number percentage limit at any accepted precision,
  rather than converting the field to basis points. Its current comparison still
  uses float division: `(Number(amount) / eligible) * 100`.
  [#9362](https://github.com/chase-sets/chase-sets/issues/9362) is open and has not
  landed at the inspected commit; it plans an exact comparison preserving the
  stored limit's precision, not a policy-schema change. Retaining the limit's
  representation does not bless the current float comparison as exact.
- [Product measures](../../contracts/product-measures/index.ts) retains number-typed
  postage thresholds, including declared-value, signature and insurance thresholds.
  These are retained policy inputs, not a request to rebuild the contract.

### 4. Decimal Storage Without A Migration

Prescribed: new money columns use `numeric(12,2)`. A wider precision requires a
stated reason. Read decimal amounts as text so driver conversion does not introduce
a JavaScript number boundary. Existing wider decimal columns and integer minor-unit
columns stay; this decision requires no migration. Integer cents are accepted
where they mirror an integral provider quantity, as in the storage examples above.

### 5. Proportional Allocation And Persisted Schedules

Prescribed: use `allocateMoneyByLargestRemainder` for proportional splits unless
an established, persisted schedule must remain stable. The helper distributes
remaining cents by descending remainder, with input order breaking ties, for
positive total weight; callers must supply meaningful weights for their domain.

Retain Payments' refund-cap schedule in
[buildOrderRefundCaps](../../bounded-contexts/payments/features/payments/api/runtime.ts)
and its cancellation checkout-fee schedule in
[allocateCheckoutFeeCents](../../bounded-contexts/payments/features/refunds/integrations/ordering/order-cancellation-refund-effect-projection.ts).
Both floor each non-last order's proportional share and give the remainder to
the last order. These are the recorded exceptions preserved by the
[#8695 slice](https://github.com/chase-sets/chase-sets/issues/8695), which is still
open at the status inspection; their schedule already exists at the inspected
commit, even though its cent-math hardening has not landed there. Replacing the
schedule with largest remainder would desynchronize refund caps already persisted
in events. Keep both schedules' existing floor arithmetic as well as their shape:
an exact bigint floor gives different cents for large in-range totals (the #7112
vector yields cap `9733533401.24` today and `9733533401.23` under bigint), which
would also desynchronize persisted caps. #8695 routes inputs and outputs through
the primitive and keeps both floors unchanged.

### 6. Currency Revisit Trigger

The first supported currency whose minor unit is not two decimals requires a new
ADR adding a currency exponent to the primitive. Do not add speculative
multi-currency types or change existing amounts in this record.

### 7. Partial Enforcement

[#9365](https://github.com/chase-sets/chase-sets/issues/9365) is open and its guard
has not landed at the inspected commit. It prescribes a syntactic `parseFloat`
regression ratchet in `check:structure`, whose current entry point is
[scripts/check-structure.mjs](../../scripts/check-structure.mjs). The proposed
ratchet rejects new occurrences; it is not proof that existing float paths are gone.

That guard does not detect `Number(x)`, unary `+`, `parseInt`, `toFixed` or aliases.
Rules 2 and 3 otherwise rest on review, both before and after the guard lands.
Do not describe a syntactic ratchet as complete money-arithmetic enforcement.

## Consequences

- Decimal strings keep API payloads and events JSON-compatible while bigint
  cents make authoritative calculations exact. Database decimal storage and
  provider minor units remain boundary representations, not competing arithmetic
  implementations.
- Rounding and allocation are explicit domain choices. Stable persisted schedules
  remain reproducible instead of silently acquiring a different cent distribution.
- Reviewers have one citable rule and a bounded list of retained exceptions.
  Enforcement remains partial; neither this ADR nor a future `parseFloat` ratchet
  establishes that every existing money path is exact.
- No code, schema, test, guard or storage migration is shipped here. A currency
  exponent design waits for the stated trigger, rather than complicating USD now.

## Alternatives Considered

- **Integer cents everywhere:** offers the same exactness as decimal strings with
  bigint-cent arithmetic, but requires migrating hundreds of columns and every
  event schema and API payload. Maximum cents, `999999999999`, fit safely in a
  JSON number; range is not the rejection reason. Boundary churn without an
  exactness gain is.
- **A decimal library (`big.js`, `dinero.js`):** bigint already covers every needed
  operation with no dependency. A second arithmetic model adds dependency and
  consistency costs without a missing capability to justify them.
- **Floats with rounding at the edges:** permits intermediate precision loss;
  rounding later cannot restore the intended comparison or allocation. This is
  the source of the one-cent bugs fixed in
  [#3564](https://github.com/chase-sets/chase-sets/issues/3564), not an alternative
  to the canonical primitive.
