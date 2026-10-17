# Saved List Analytics Privacy Contract

This contract governs operational labels emitted by the optional `savedListAnalyticsRecorder` host port. Client-facing `analyticsLabel` hints are not these events. No browser bridge, metrics or rollout gate is part of this contract.

## Events

| Event | Label keys |
| --- | --- |
| list_created | surface |
| product_added | surface, outcome |
| first_five_lines | surface |
| valuation_coverage_band | coverage_band, estimate_state |

## Allowed values

| Label key | Allowed input values |
| --- | --- |
| surface | search, item-detail |
| outcome | added, merged |
| coverage_band | empty, none, low, partial, high, full |
| estimate_state | empty, incomplete, stale, low_confidence, current |

Every emitted event has `event` and all four label keys. A key absent from its event's key tuple emits `none`; a supplied value outside its allowed input tuple (including null or undefined) emits `invalid`. Neither `none` nor `invalid` is an allowed input token, though both are permitted output values for every key.

## Forbidden keys

`listId`, `lineId`, `commandId`, `catalogItemId`, `productId`, `accountId`, `verifier`, `secret`, `note`, `tag`, `trackedQuantity`, `unitEstimateAmount`, `estimatedValueAmount`, `estimatedTotalAmount`, `estimatedValueBand`, `estimatedTotalBand`, `lowAmount`, `highAmount` must never enter the recorder. The allowlist of keys and values, not a substring scan, enforces this boundary. No identifier, capability, note, tag, quantity, cost, or money amount is a label.

## Derivation

For coverage, compare integer line counts `priced` and `total` in order: total zero is `empty`; priced zero is `none`; priced times 2 below total is `low`; priced times 10 below total times 9 is `partial`; priced below total is `high`; otherwise `full`. Estimate state uses first match: total zero `empty`, missing positive `incomplete`, stale positive `stale`, lowConfidence positive `low_confidence`, otherwise `current`. No monetary field participates.

The addition handler emits only for a non-replayed receipt. `list_created` requires receipt outcome `created`; `product_added` uses response line status. `first_five_lines` requires five resulting lines and four prior lines, computed by subtracting added and adding removed receipt line results. Recording is detached and cannot change the response.
