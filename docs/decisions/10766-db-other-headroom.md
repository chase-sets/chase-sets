# DB-other headroom decision

**Decision status: `REJECT_AND_ESCALATE`**

This Probe is decision-only. It does not change the runner, workflow, tests,
timeouts, concurrency, retry semantics, or coverage. The implementation
successor is [#10766 Restore deterministic headroom for Platform PR DB Profile Tests (other)](https://github.com/chase-sets/chase-sets/issues/10766).

## Selected mechanism under test

The only mechanism inside the unchanged fences that could create headroom is a
coverage-preserving reduction of measured test work in the hot files of
`marketplace-seed-testing`, `catalog`, and `channels`. The successor must scope
that work reduction and prove it on its changed exact head. This Probe rejects
the mechanism as **not yet feasible**: existing hosted measurements provide no
causal reduction model, and the unchanged strict AC3 bounds cannot be inferred
from hint refresh or partition ordering.

## F1 causal explanation

At `other=3`, the scheduler executes each partition serially in one slot. The
wall lower bound is `ceil(sum(actualDurationMs) / 3)`; hint refresh and
repartitioning can change assignment/order but do not remove work. The prior
implementation's exact-head sample therefore does not establish headroom: its
wall was fast, while the same plan at the immediately preceding head and four
of five base controls exceeded the strict wall bound. The three largest exact-
head workspaces also exceeded the strict per-workspace bound.

The unchanged fences are: complete 24-workspace DB-other census; concurrency 3;
workspace ceiling 600,000 ms; job timeout 1,800,000 ms; strict AC3 workspace
bound `<480,000 ms`; strict wall bound `<1,440,000 ms`; no skips, retries,
quarantine, fixture-only proof, or coverage reduction.

## Measured hosted evidence

All records below are existing successful `DB Profile Tests (other)` jobs,
`merge_group`, attempt 1, complete 24-workspace census. They are historical
authority, not a new five-run predicate or a hosted pass for this Probe.

### Wall and hot-workspace observations

| role | run / job | exact head | source summary | wall `elapsedMs` | `marketplace-seed-testing` | `catalog` | `channels` |
|---|---:|---|---|---:|---:|---:|---:|
| base | 40855476569 / 123386179586 | `4fa5addf2187d672159806ab76f7a630bcc1228c` | hosted run 40855476569 / job 123386179586 (log line 38522; https://github.com/chase-sets/chase-sets/actions/runs/40855476569/job/123386179586) | 1,083,932 | 760,805 | 670,067 | 386,096 |
| base | 41260724592 / 124713769634 | `4a1d9872d36f86dcb67bd1c69a4d5d8d2cbc245f` | hosted run 41260724592 / job 124713769634 (log line 38875; https://github.com/chase-sets/chase-sets/actions/runs/41260724592/job/124713769634) | 1,530,928 | 1,088,145 | 974,420 | 514,591 |
| base | 41273034278 / 124749753264 | `f06a6b4e054167e8e4539d162c19e970157f4566` | hosted run 41273034278 / job 124749753264 (log line 38955; https://github.com/chase-sets/chase-sets/actions/runs/41273034278/job/124749753264) | 1,641,204 | 1,195,364 | 1,045,536 | 544,296 |
| base | 41286534242 / 124789100638 | `6b06a1f70969eb2126f354e2dec09a3d37da12ba` | hosted run 41286534242 / job 124789100638 (log line 38657; https://github.com/chase-sets/chase-sets/actions/runs/41286534242/job/124789100638) | 1,544,154 | 1,119,013 | 986,920 | 505,889 |
| base | 41296486752 / 124818841702 | `aa67b85273c8443f25b771e850255a8a9c5e42f9` | hosted run 41296486752 / job 124818841702 (log line 38553; https://github.com/chase-sets/chase-sets/actions/runs/41296486752/job/124818841702) | 1,561,107 | 1,120,775 | 997,339 | 522,896 |
| head-1 | 41307863860 / 124852647831 | `4df44ae91ed01ee3a6d554d2717b9c0604d2f2c3` | hosted run 41307863860 / job 124852647831 (log line 39183; https://github.com/chase-sets/chase-sets/actions/runs/41307863860/job/124852647831) | 1,539,276 | 1,023,516 | 913,289 | 678,274 |
| exact head | 41314707020 / 124873067274 | `0b7fc3aea54cf7fb00e0701052004115d331f402` | hosted run 41314707020 / job 124873067274 (log line 38794; https://github.com/chase-sets/chase-sets/actions/runs/41314707020/job/124873067274) | 1,119,510 | 709,677 | 630,319 | 521,454 |

The required F1 values are present: exact-head workspaces
`709677/630319/521454`, exact-head wall `1119510`, head-1 wall `1539276`,
and base walls `1561107/1544154/1641204/1083932/1530928`.

### Per-workspace maxima across the five base captures

| workspace | maximum `actualDurationMs` |
|---|---:|
| `@chase-sets/app-platform-worker` | 88,990 |
| `@chase-sets/auth` | 183,222 |
| `@chase-sets/bounded-context-runtime` | 42,360 |
| `@chase-sets/catalog` | 1,045,536 |
| `@chase-sets/channels` | 544,296 |
| `@chase-sets/checkout` | 127,305 |
| `@chase-sets/collections` | 25,578 |
| `@chase-sets/commercial-terms` | 4,287 |
| `@chase-sets/customer-feedback` | 12,166 |
| `@chase-sets/discovery` | 354,022 |
| `@chase-sets/event-core-postgres` | 16,642 |
| `@chase-sets/fulfillment` | 26,236 |
| `@chase-sets/identity` | 41,605 |
| `@chase-sets/inventory` | 443,506 |
| `@chase-sets/marketplace` | 112,332 |
| `@chase-sets/marketplace-seed-testing` | 1,195,364 |
| `@chase-sets/notifications` | 7,227 |
| `@chase-sets/ordering` | 88,004 |
| `@chase-sets/payments` | 90,150 |
| `@chase-sets/platform-operations` | 111,706 |
| `@chase-sets/platform-policy` | 4,688 |
| `@chase-sets/platform-runtime` | 32,486 |
| `@chase-sets/pricing` | 271,347 |
| `@chase-sets/settlement` | 54,211 |

## Deterministic feasibility calculation

The complete machine-readable calculation is
[`10766-db-other-headroom-calculation.json`](./10766-db-other-headroom-calculation.json).
It records every run/job/head/source line, the 24-workspace census, and the
inputs below.

For the exact head, measured work is `3,355,400 ms`; the fixed-three-slot lower
bound is `ceil(3,355,400 / 3) = 1,118,467 ms`. The wall sample is below the
strict bound, but per-workspace reductions of at least `229,678 ms`
(`marketplace-seed-testing`), `150,320 ms` (`catalog`), and `41,455 ms`
(`channels`) would still be required to get each below `480,000 ms`.

The head-1 measurement has `4,614,791 ms` of work and a lower bound of
`1,538,264 ms`, already `98,264 ms` above the strict wall bound before runner
variance. The observed wall is `1,539,276 ms`. The five base walls include four
strict failures, with a maximum of `1,641,204 ms`.

Because no measured candidate change reduces those work units, this model cannot
establish strict AC3. The status is therefore `REJECT_AND_ESCALATE`, not
`IMPLEMENT` and not a hosted pass. The successor must either produce a
coverage-preserving work-reduction model with exact-head proof or route a scope
decision; it must not raise ceilings, change concurrency, skip/retry tests, or
reuse this Probe as implementation evidence.

## Rejected alternatives

- **Hint refresh or repartition-only changes:** reorder existing work; F1 shows
  no causal reduction and the lower bound remains.
- **Timeout or concurrency increases:** violate the unchanged authority fence.
- **Skip, retry, quarantine, conditional hiding, or test deletion:** violate
  complete coverage and retry semantics.
- **Fixture-only timing or local DB timing:** not the live Platform PR caller
  and not hosted authority.
- **Runner/parser-only changes:** improve attribution and evidence, but cannot
  reduce DB work; F2-F4 remain successor floors.

## Successor handoff

[#10766 Restore deterministic headroom for Platform PR DB Profile Tests (other)](https://github.com/chase-sets/chase-sets/issues/10766)
is the implementation successor and is blocked by this decision. Its mandatory
floors are:

1. Preserve real failed/skipped Vitest attribution lines.
2. Add injected-run collection plus validator/census mutants.
3. Accept only `runAttempt === 1` for authoritative captures.
4. Prove the unchanged strict AC3 predicate on five independently identified
   exact-head `merge_group` jobs, attempt 1 only, with complete census.

The source and caller inventory remains unchanged from the issue brief:
`scripts/run-workspaces.mjs:125,477,638-665,710-731`,
`scripts/run-workspaces.test.mjs:623,918-991,1550-1552,1848-1849`,
`.github/workflows/platform-pr.yml:390`, plus the listed coverage, package,
drift, baseline, scope, and heavy-slot checkers. The native GitHub dependency
must remain `10945 Blocks 10766`; no implementation code is included here.
