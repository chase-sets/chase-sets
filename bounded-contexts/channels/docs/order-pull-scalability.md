# Order Pull Scalability Worksheet

This worksheet evaluates the decided production envelope, not the currently
shipped executor. It supplies governed values for #8804; it does not qualify
provider authority, activate production, or accept source implementation.

## Authority And Values

[FINAL scalability r2][final] governs the allocation and continuation law.
Its identical [consumer copy][consumer-final] has the same SHA256:
`29cb760078c71f8510dee46fa570f5d20e2b4d47a146390bf4f7bbc809670b90`.
Only the six unchanged ceilings and non-superseded abort rules from
[envelope Table 1][envelope] survive that earlier decision. Its population cap,
coupled equation, page relation and later-poll throughput claims do not.

| Authority field         | Governed value            | Production basis                                                                                                |
| ----------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `lawVersion`            | `ready-to-ship-intake/v1` | [FINAL r4][r4], retained spelling in #9130; #9138 owns closed-contract compatibility, not this worksheet        |
| `nIntakeReadMax`        | 8                         | [FINAL r2, Envelope arithmetic][final]: per-job ceiling, not population                                         |
| `nListReadMax`          | 2                         | [FINAL r2, Envelope arithmetic][final]: detection and all traversal pages count                                 |
| `fMax`                  | 5                         | [FINAL r2, Fair follow-ups][final]: reserve five when five are due                                              |
| `providerCadenceMs`     | 10000                     | [Table 1][envelope]: governed runtime floor, serial calls, including first call and across jobs                 |
| `providerCallTimeoutMs` | 10000                     | [Table 1][envelope]: hard abort through headers, bounded body read and closed parse                             |
| `mappingJournalMs`      | 20000                     | [Table 1][envelope] and [FINAL r2][final]: aggregate mapping, stripping, journal, checkpoint and successor work |
| `maxPostsPerOrder`      | 4                         | [Table 1][envelope]: sale, summary, fulfillment and status-only; recovery spends the same slots                 |
| `postTimeoutMs`         | 5000                      | [Table 1][envelope]: each one-event admission, including response and parse                                     |
| `reportTimeoutMs`       | 10000                     | [Table 1][envelope]: claimed-outcome report, including continuation admission                                   |

This inventories every governed authority field except `revision` and `selector`
in the decided contract. Remove `nRtsMax`; there is no page/population relation.
Traversal chunk and byte bounds belong to qualified bounds/codecs, not invented
governed authority fields. If #9138 changes the field set or law spelling, reconcile
the binding with its explicit compatibility decision before admission; no missing
field gets a guessed value. #9130 owns source equality and fail-closed controls.

The deadline remains 600000 ms and the strict lease margin 30000 ms. Check the
actual remaining lease; 1800000 ms is the default, not permission to assume a fresh
lease. These are Chase-owned constraints, not measured provider performance.
The #8607 30000 ms probe setting and #9112 synthetic fixtures are not value authority.

## Allocation Arithmetic

Let L count every list read, including detection. Reserve one session lookup
separately. I and F are actual allocated intake and follow-up details. One provider
call is in flight; each is charged 10000 ms idle gap plus 10000 ms call ceiling.

```text
B = (1 + L + I + F) * 20000 + 20000 + (I + F) * 4 * 5000 + 10000
  = 50000 + 20000 * L + 40000 * (I + F) <= 600000 ms
B + 30000 < actual remaining lease
```

Independent maxima cannot simply be added. Allocate within the plan:

| L                | I   | F   | B (ms)        | B + margin (ms) | Decision                                                  |
| ---------------- | --- | --- | ------------- | --------------- | --------------------------------------------------------- |
| 1                | 8   | 5   | 590000        | 620000          | Fits default lease                                        |
| 2                | 8   | 5   | 610000        | 640000          | Refuse allocation; replan I to 7, never size-fail account |
| 2                | 7   | 5   | 570000        | 600000          | Fits default lease                                        |
| 2                | 0   | 5   | 290000        | 320000          | Enumeration/follow-up job fits                            |
| 1                | 1   | 0   | 110000        | 140000          | Sparse intake fits                                        |
| Absent authority | -   | -   | Not evaluated | Not evaluated   | `authority-unknown`; no provider call                     |

Both 620000 and 600000 are strictly below 1800000. Equality with the actual
remaining lease refuses. Boundary comparisons freeze every other variable:
L 1 to 2 at I8/F5 crosses the deadline; I 8 to 7 at L2/F5 restores fit.
Missing/invalid page or cursor authority is a separate refusal, not a budget test.
Executable one-clause bypass controls belong to #9130, not this arithmetic proof.

## Execution Conditions

1. Idle detection occurs within 60 s. A negative needs a qualified Ready to Ship
   entry/change frontier and no durable unread work. Equal counts, a known first
   row, creation sorting, empty cache and HTTP 202 are insufficient. Cover older
   orders newly Ready to Ship, without an unqualified date-range exclusion.
2. Positive detection freezes selector/session/frontier for stable snapshot/cursor
   traversal or a proved keyset/change-frontier equivalent. Persist bounded
   PII-free chunks; accepted-intake membership comes from the existing fact owner.
   Unknown members drain FIFO, never-attempted before persistent gaps. Reconcile
   uniqueness, terminal cursor and independent total where supplied. Full pages
   continue; mutable offsets and equal-count rescans cannot prove completeness.
3. Pending pages, unread references, exhausted allocation or a due follow-up tail
   commit a checkpoint and exactly one due-now successor through the existing
   coordinator. Fence burst, predecessor/checkpoint digest, connection,
   selector/policy revision, attempt and generation. Replays recover that successor;
   stale claimants cannot advance it. Bypass only the idle 60 s gate, retaining
   provider spacing and fresh budget/lease checks. Healthy commit-to-claim <=10 s
   requires the real connector to re-claim after report, not await its alarm.
4. Exhaustion plus accepted facts or explicit qualified gaps permits drained
   classification, not an all-success claim. HTTP 202 is pending, never acceptance.
   Posted-unaccepted-only work remains durable, detection non-negative and idle
   rechecked; it must not mint a no-progress due-now loop. #8612 must prove existing
   #7030 owner acceptance by each checkpoint within the aggregate 20 s allowance,
   not rely only on its 60 s runner. Delayed owners invalidate successful latency,
   never justify completeness. Pause, revoke and session loss retain pending work.
5. Hard aborts include response reading/processing and every post/report. Cancel
   fetch/reader on timeout and discard late results. Failed lookup/search makes
   intake unknown with zero details; a failed detail is an explicit gap. After
   429/5xx make no further provider call. No in-job retries or persistent-error
   immediate spin; retain work under existing error/session policy and attention.
6. Charge actual calls/posts/recovery; exact-byte reposts do not create free slots.
   Mapping/journal overruns start no further calls/posts. A new operation may not
   consume the remaining report allowance or exceed the job budget. End early
   enough to report/continue; jobs never sleep until B expires. Preserve ambiguous
   post exact-byte recovery and captured-202 report-only recovery. Byte caps and
   largest-valid/cap+1/endless controls remain consuming-slice obligations.

## Conditional Intake Estimates

All numbers below are **estimated ceiling bounds, not measurements or shipped
SLAs**. Assume valid authority, readable/mappable details, accepted posts visible
by checkpoint, healthy connected service, qualified page size >=8, bounded chunks,
FIFO finite cohorts, initial idle wait <=60 s and continuation handoff <=10 s.
Smaller qualified pages require recomputing guaranteed progress. Daily averages
cannot establish a burst or tracked population; no observation scheme guarantees
an order entering and leaving Ready to Ship entirely between observations.

The conservative burst plan uses L2/I7/F5, with a smaller final I. For a cohort N,
`j = ceil(N/7)`, `r = N - 7*(j-1)` and
`t(N) = 60 + (j-1)*(570+10) + (90+40*(r+5))` seconds.
The one-order row instead reserves one due follow-up: `60 + B(2,1,1)/1000 = 230`.

| Account / initial cohort     | Jobs | Full initial intake  | Cleared-backlog idle / occupied | Coverage at actual T                 |
| ---------------------------- | ---- | -------------------- | ------------------------------- | ------------------------------------ |
| 1/day; 1 new; T<=1           | 1    | <=3m50s (230 s)      | <=3m50s / 13m00s                | T1: <=40m10s                         |
| 50/day; 50 new; T<=50        | 8    | <=1h14m10s (4450 s)  | <=6m30s / 15m40s                | T50: <=2h11m40s                      |
| 500/day; 300 backlog; T<=800 | 43   | <=6h55m50s (24950 s) | <=6m30s / 17m40s                | T500: <=17h26m40s; T800: <=27h36m40s |

| Additional finite cohort | Jobs | Full intake bound     |
| ------------------------ | ---- | --------------------- |
| 301                      | 43   | <=6h56m30s (24990 s)  |
| 500                      | 72   | <=11h34m10s (41650 s) |
| 800                      | 115  | <=18h29m10s (66550 s) |

One new order, no due follow-up and a reused detection page costs <=170 s:
`60 + B(1,1,0)/1000`. Cleared-backlog rows assume uniform arrivals and one-day
tracked residence. Idle 50/day and 500/day is `60+B(2,1,5)/1000=390` s.
Occupied rows allow an existing 600 s job and 10 s handoff:
`600+10+B(2,1,1)/1000=780`, `600+10+B(2,1,5)/1000=940`, and
`600+10+B(2,4,5)/1000=1060` s. Uniform 500/day has at most four arrivals
during the occupied wait; concentrated arrivals need a larger cohort bound.

For 300 backlog plus ongoing uniform 500/day, estimated ceiling-profile capacity
is `7*86400/580 = 1042.7586...` orders/day (approximately 1042.76, not a rounded-up
strict lower bound). Whole-queue catch-up is bounded by 83 jobs:
`t=60+83*580=48200` s, or 13h23m20s;
`ceil(48200*500/86400)=279` arrivals; `83*7=581 >= 300+279=579`.
This bounds the whole queue, not just the original 300. During backlog, use the
finite FIFO cohort wait, not cleared-backlog latency. Above-capacity or arbitrarily
concentrated arrivals have no such bound without a new rate/cohort assumption.

## Follow-Up Coverage

Reserve five distinct due follow-ups in every productive job when five are due,
even on negative intake detection. Oldest-first fair rounds advance the attempt
cursor on failure; only successful observations advance `lastObserved`. New
entrants join the next round. A remaining due tail continues now; failures cannot
pin the head. One qualified detail/reference/job serves overlapping intake,
fulfillment and status work. Overlap only improves these conservative bounds.

For a frozen actual eligible nonterminal cohort T:
`W(T)=ceil(T/5)*(600+10)` s and
`coverage <= configuredInterval + W(T)` under continuous healthy service.
The default 1800 s / minimum 300 s interval is an eligibility floor, not maximum
observation age. Failed reads guarantee bounded attempts only, not observations.

| T    | W(T), seconds | Coverage with default 1800 s |
| ---- | ------------- | ---------------------------- |
| 1    | 610           | <=40m10s                     |
| 50   | 6100          | <=2h11m40s                   |
| 150  | 18300         | <=5h35m                      |
| 500  | 61000         | <=17h26m40s                  |
| 800  | 97600         | <=27h36m40s                  |
| 2500 | 305000        | <=85h13m20s                  |

T is not orders/day. Five-day residence at 500/day gives T2500; one-day residence
is only the preceding table's assumption. Expose volume-aware capacity and overdue
attention. There is no invented 30-minute delivery SLA: 500 serial details require
at least 5000 s from the 10 s spacing floor alone. Raising F without reallocating
I/L would exceed the unchanged budget.

## Admission Volume And Authority Gap

Let J90 be the actual admitted job count over 90 days, or a separately proved
coordinator throughput bound. For a bounded serialized event size B_event,
`sale + summary bytes <= J90 * (8+1) * B_event`.
Count follow-up, fulfillment and recovery admissions separately; do not double
count an overlapping read, but count every admitted envelope. This is admission
volume, not physical retention, deletion timing or an expiry/backpressure SLA.
`ceil(7776000/C)` is not a job-count ceiling: continuations bypass idle cadence C.
No numerical J90 or B_event is fabricated here.

#9142 must qualify actual worker-request detection and first/next pages under the
same session/frontier, including older newly eligible orders, churn, hard caps,
bytes, cursor/end/count invariants and the actual mapper. #9115's one-page capture,
pageSize>=101 and proposed size500 do not establish this authority. Missing
authority stays missing; composition and provider-dependent acceptance remain
blocked. An unsound native mechanism returns to the host for an independent
decision; full enumeration is not one cheap negative read. No provider call is
needed to choose these Chase-owned ceilings.

[final]: https://github.com/chase-sets/chase-sets/issues/8804#issuecomment-6070712466
[consumer-final]: https://github.com/chase-sets/chase-sets/issues/8612#issuecomment-6070713604
[envelope]: https://github.com/chase-sets/chase-sets/issues/8804#issuecomment-6070323426
[r4]: https://github.com/chase-sets/chase-sets/issues/8608#issuecomment-6006880072
