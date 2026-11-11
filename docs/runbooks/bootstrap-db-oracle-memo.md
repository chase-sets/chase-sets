# Hosted Bootstrap Oracle Memo

The host derives a canonical memo from an immutable, unmerged enrollment
projection. This route does not measure a workload, grant a queue turn, accept a
capture, publish code, or qualify a product head. The producer and pinned oracle
remain unchanged. Chase Sets never contacts TCGplayer servers and never stores
or uses TCGplayer auth cookies or credentials.

## Immutable Inputs

`S` is the accepted product source. `W` is its sole capture-only child. `R` names
the independently accepted current/paired capture. Freeze the complete S
source/absence closure, discovered bootstrap and non-bootstrap inventories,
numbered package execution units, case identities, boot-bearing membership,
immutable model limits, and accepted pair hashes before constructing `E`.

The canonical publication author builds `E`: S plus only the three accepted
capture/baseline fixtures and the checker's five authorized value initializer
spans. Preserve the old memo, producer, oracle, checker skeleton, and dependency
closure. `T` is the reviewed route already landed on main, not E or the runner
merge commit. A v2 manifest records these full commit/tree identities, exact
sorted input delta, accepted fixture hashes, literal values, raw NUL-delimited
Git tree digest and locked toolchain. Input is canonical UTF-8 JSON with one LF,
at most 256 KiB; no D self-hash or executable payload is accepted.

The normative v2 shape and independent-source constraints are indexed by
[#11214 Derive canonical bootstrap memos in a PR-isolated artifact job](https://github.com/chase-sets/chase-sets/issues/11214).
Historical v1 JSON remains readable but cannot authorize v2 acceptance.

## Open Once

Every step below is mandatory and precedes the single opening in this order.

1. Under the unchanged host admission, run `node scripts/bootstrap-db-oracle-memo-artifact.mjs preflight` from the clean T checkout. Retain actual workflow ID, path, active state, observation time and complete bounded run inventory. Any pending, queued, requested, waiting or running entry refuses opening. An incomplete inventory is unknown, never empty. Preflight is an inventory diagnostic, not sufficient opening authority alone.
2. Create `D`, the sole E child, with a new `bootstrap-db-oracle-memo-input.json` manifest inside its `.github` directory and, only if absent from E, the byte-identical T workflow. This data-only manifest is created only in D and must remain absent from E and main. Never merge D. Push D as the head of its `memo-derivation/` branch and fix `B`, the exact full `main` commit it opens against; steps 3 and 4 use exactly the B and D that step 5 freezes.
3. Obtain a fresh independent input review of the exact E, D, manifest and body bytes. A review of an earlier D or B does not carry over.
4. Fetch `main` and the derivation branch into a clean checkout of landed `main` that contains the `mergeability` command and run `node scripts/bootstrap-db-oracle-memo-artifact.mjs mergeability <B> <D> <memo-derivation/branch>` with full 40-hex B and D. Use that `main` checkout even when the manifest's T predates the command; the command reads T only from D's committed manifest, so the running checkout never stands in for T. It refuses, printing no record, on any content or structural conflict (naming the unmerged paths), missing or non-commit object, unknown merge result or Git without merge support, or a workflow that is not one regular `100644` blob identical at T, B, D and the computed merge tree. Its final step rechecks that B still equals live `main` and D the live branch head. Only a zero exit with its printed record allows continuing. Retain that record beside the freeze as a sibling record, not a freeze field. Its `diagnosticMergeTree` is never G; GitHub `mergeable` is post-open data and null means unknown.
5. Retain the host freeze containing `head` D, `base` B, `input` E, `manifestSha256`, `bodySha256`, `observedAt` (canonical UTC), and `preflight` (the complete preflight result). Reconcile those values with the accepted source/pair inventory and the mergeability record, not E-derived authority. The freeze `observedAt` follows the review and the record's `observedAt`. Keep the manifest/body bytes and their hashes with that freeze.
6. Immediately before opening, refresh identities: live `main` must still equal B, the branch head D, and the manifest/body bytes those reviewed and frozen. Any drift means refreeze and reprobe (repeat steps 1 and 3-5) before opening; never open on an earlier preflight, review or record.
7. Open one same-repository `memo-derivation/` PR into main. Its entire body is `bootstrap-db-oracle-memo-input-sha256: <64 lowercase hex>` followed by one actual LF, exactly 104 UTF-8 bytes. The prefix is not an authority grant. Do not synchronize, reopen, dispatch, rerun, cancel, or auto-apply.

Only `pull_request: opened` can start `deriveMemo`, and GitHub runs no
`pull_request` workflow for a conflicted PR. An opening without an admitted run
is spent: close it unmerged and never synchronize, reopen, dispatch, rerun or
cancel it. No mergeability record is run or reconstructed after an opening. A
source refresh that changes S needs a fresh W/R capture, never a rebind of the
old capture. Eligibility is evaluated before the job-level global concurrency
group, so unrelated PRs cannot evict a pending memo job.
`cancel-in-progress: false` does not protect an older pending job against
another eligible opening; the host's preflight remains mandatory. The
mergeability guard changes no single-flight completeness, attempt1 acceptance,
original event/G, three-payload, P or merge-group boundary.

The data-only bootstrap reads the original event, D's regular manifest blob and
actual runner/context identities before selecting, installing or importing T.
`G` is the actual `GITHUB_SHA`, independently resolved through the immutable Git
commit API with exactly B/D parents. Payload `merge_commit_sha` is recorded as
absent, null, or SHA; only a present SHA must equal G. Absence/null never supplies
G. Workflow bytes at D/B/G/context must equal landed T before selected code.
T then validates E's data-only delta and independently reconciles S/pair
membership, values and order before input dependency installation.

## Derive And Accept

The standard Ubuntu job has `contents: read`, no environment, OIDC, write scope,
capture download or cache. Pinned actions use nonpersisted credentials. It runs
the unchanged producer exactly once from `deployables/platform-api`, under the
unchanged 30-minute bound. Complete working read closure excluding the memo must
remain equal. Only the memo may change.

Upload occurs only after producer and validator success. Exactly three regular
payloads are eligible: `bootstrap-db-oracle-schedule-memo.json`, `receipt.json`,
and `SHA256SUMS`. The two ordered payload sums are inside the archive bound by
the outer digest. Memo, receipt, sums and ZIP limits are respectively 1 MiB,
2 MiB, 4 KiB and 4 MiB. The parser refuses extra/duplicate/traversing/link paths,
CRC or expanded-size mismatches and unsupported archive records. Diagnostics
are never canonical payloads.

Wait for completion before collecting jobs/artifacts. From the clean T checkout
with sibling `objects` and clean E `input` directories, set `MEMO_BOOTSTRAP` to
the retained execution-time bootstrap record and `MEMO_FREEZE` to the independent
pre-open freeze. Run:

```sh
node scripts/bootstrap-db-oracle-memo-artifact.mjs accept <run-id> <artifact-id>
```

The collector paginates jobs, artifacts and PR lifecycle events with hard caps;
unknown, changing or incomplete inventories refuse. It downloads the actual
canonical ZIP and requires completed-success attempt 1, head D, exact-one numeric
job joined through the receipt's check-run URL ID, and successful ordered admit,
clean-input, producer, validator and upload steps. Job ID and check-run ID are
not assumed equal. Receipt producer timestamps must lie within the owning step
and job (at most 999 ms API rounding tolerance). Recheck the current D/body/base,
original event digest, E/read closure, workflow context and independent freeze.
A closed/reopened lifecycle cannot reuse the original run. Run success and
`run.pull_requests` are not admission authority.

Wrong identity, drift, conflict, producer failure, overrun, nondeterminism,
partial output, expiry or missing evidence stops to the host. Do not rerun to
replace a failure. Preserve the refusal and original evidence.

## Publish And Check

Only the canonical author copies accepted memo bytes and updates the ordinary
pin into `P`. `node scripts/bootstrap-db-oracle-memo-artifact.mjs application
<P-sha> <run-id> <artifact-id>` redoes acceptance and verifies P's memo digest and
producer/oracle/checker/fixtures against E. It does not write, grant publication,
or claim product qualification. Other read-closure drift must pass the original
P and merge-group checks or require re-derivation.

The eighteenth gate, `Bootstrap DB Oracle Memo Check`, is HOSTED_ONLY with no
local command/executor. Memo, producer, oracle or checker add/edit/delete/rename
changes select it in both PR and merge-group plans; other changes do not. PR
Required requires the selected job to succeed. From the repository root it runs
exactly once, under a separate 30-minute bound:

```sh
node deployables/platform-api/__tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs --check
```

Retain the executed consumer job/head, raw CLI zero exit, unchanged enrollment
suite zero exit, and merge-group proof. Unit's 20-minute bound, assertions,
corpus, pins and scheduler remain unchanged. Derivation is not a raw-check PASS.
At steady state the accepted memo/pin and original product checks land together;
the derivation PR remains unmerged. Route landing alone closes neither the
successor's acceptance obligations nor its tracking predecessor. The host owns
first derivation, acceptance, consumer proof, closure and all landing decisions.
