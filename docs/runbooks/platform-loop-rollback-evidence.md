# Platform Loop Rollback Evidence

**Disposition: NOT EXERCISED.** This factual record is for chase-sets #8393
and milestone 181. It does not satisfy the live-worker rollback gate and does
not close the issue.

## Runs

### Run 1: `m2-rollback-drill-20260929T2340`

- Target: milestone 181, issue #8393; config
  `.orchestrator/platform-runs/m2-rollback-drill-20260929T2340/loop.json`,
  SHA-256 `ca7506fb1ccdf888a4e517cbea4ef2400e2f3694c10abb41b6f377e8415f1fa0`.
- Executor: `d9a78e0b3e237736d4e3d5bd5d2cf48aaae1ba11`; author
  `gpt-6-sol/medium`; reviewer `gpt-6-astra/high`.
- Live binding was observed at `2026-09-29T23:36:04.594Z` in
  `probe-live1-20260929T233604589Z.txt` (SHA-256
  `c9cfc6876ab7caa905ee7a56db8b25e9e327f8e0296e3a08f2857b854d3b50ed`),
  boot `3f57c0ba-db74-4c2e-9d7d-8bfb48736c44`, CLK_TCK 100. The captured
  forest included supervisor PID 1504483 (PGID/SID 1504462), detached
  observer PID 1505269 (PGID/SID 1505269), and author PID 1505276 (same
  observer group), with PPIDs, executables, working directories, command lines
  and `/proc` start ticks. The binding was posted on platform #368 comment
  5901111692 before any signal.
- The author exited naturally at about `2026-09-29T23:38:28Z`.
  `signal-20260929T233855Z.log` (SHA-256
  `b213240415ee6040636c8ed56a0da3c44d0c1952a688e7ebeed6a3437390d9dd`)
  revalidated and terminated supervisor PGID 1504462 at `23:38:55Z`; the
  observer/worker group and separately grouped descendant were already gone.
  The dead-after census (`census-after-signal.txt`, SHA-256
  `6bf62423e54723fdeea5371caa42c58bc5336b5b5f717ce2002e4677b6d8e620`)
  was empty for owned processes.
- Host release comment 5901323181 recorded the supervisor stop as exercised,
  but explicitly recorded the live-worker stop as **NOT EXERCISED**.

### Redrill: `m2-rollback-drill-r2-20260930`

- Config `.orchestrator/platform-runs/m2-rollback-drill-r2-20260930/loop.json`,
  SHA-256 `2aa04bcf19a4d214ff656e9dfabfabe483814020fb4e69a379dbbc812a25eef1`.
  Executor was `d9a78e0b3e237736d4e3d5bd5d2cf48aaae1ba11`; Launch B used
  `gpt-6.1-sol/medium` and `gpt-6-astra/high` review, with `-Resume` at
  `2026-09-30T06:47:15.997386Z`.
- Launch A exercised only the pre-selection pause expectation. Launch B
  bound supervisor `S=1523539`, detached observer `O=1524328`, and author
  `P=1524335`. The gate took **ABORT b** at `2026-09-30T06:52:13Z` because
  PID 1525967 was outside the frozen identity envelope. There was **0 POST
  and 0 signal**. Sources: `gate-B.out` (SHA-256
  `b439d6ecc9d56fd860f1a3baca6e1e0e2fa0ff355cc34e2b645bf54004f73c89`) and
  FINAL `drill-r2-gateB-abort-decision-r1.report.md` (SHA-256
  `aecae690f3c34f8e3e88966e69ff4bc856869f4ffdfbd0641a039d8cbc650730`).
- Pause was requested at `2026-09-30T06:52:15.264Z` and acknowledged at
  `2026-09-30T07:01:48.752Z`. The loop then stopped #8393 as `author-failed`;
  this was not a worker-group signal. `status-after-stop.json` (SHA-256
  `8d2a3aca90aa57b5ebe599eb0904a6136a67bf9da4377cb77a0765291191dc18`)
  records paused status and an exited supervisor.
- The dead-after census at `2026-09-30T07:16:26.812Z` was PASS with no bound
  identity, owned SID/PGID member, or run-path residual
  (`dead-after-20260930T071626808Z.txt`, SHA-256
  `508f086c83ce627143a9433beecde1c0e7a0fccc8e2ebf8fde143d88791b00c4`).
  This proves cleanup after the abort, not a successful rollback stop.

## Acceptance coverage

| Criterion | Record |
| --- | --- |
| AC1: live supervisor and native author identities | **PARTIAL, NOT SUFFICIENT.** Run 1 has a contemporaneous live forest and binding comment; redrill B also bound S/O/P. Neither joins that live state to a completed worker stop. |
| AC2: revalidated signals for supervisor and every owned worker group | **NOT OBSERVED.** Run 1 signaled only the supervisor after the worker had exited. Redrill B aborted before POST and before any signal. No live-worker TERM/KILL sequence exists. |
| AC3: preservation, authority/return, both releases, complete PR census | **PARTIAL.** Runtime/worktrees and traces were preserved; Todd approval item 4 returned m181 to the incumbent; releases are #368 comment 5906192546 and #4388 comment 5906194764; the complete census found zero PRs and zero run branches. These records cannot compensate for missing AC1/AC2 lifecycle evidence. |

The handoff row records m181 returned to the incumbent at
`2026-09-30T07:20Z` after the redrill abort (SHA-256 of
`.orchestrator/platform-handoff.md`:
`175898a8627fc7a02e0022cf44e83d308313753e5c655453016c3b96eae5fbd8`). The
issue remains open for incumbent completion and any future live-worker drill
requires a new decision and Todd approval. No PR adoption or fabricated pass
is claimed.

## Sources and limits

Primary artifacts remain read-only under
`D:/Users/ToddS/Source/Repos/chase-sets/.orchestrator/platform-runs/` and
native runtime/worktree paths under `/root/orchestration-m2/`. The issue body,
host comment 5906417239, native loop-stop comment 5905951615, platform release
comments, FINAL decisions, and handoff were read. Secrets and raw environment
values are omitted. No incumbent completion, independent final-head review,
hosted CI, or landing exists yet; those are AC4 work after this factual
record.
