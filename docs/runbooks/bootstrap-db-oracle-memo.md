# Hosted Bootstrap Oracle Memo

This route derives the canonical bootstrap schedule memo from a reviewed,
immutable, unmerged enrollment projection. It does not measure, capture, deploy,
publish, grant a capture turn, or qualify a product head. Only the canonical
enrollment author may prepare the input projection and copy accepted bytes into
the later publication commit. Capture ordering and eligibility remain unchanged.

Chase Sets never contacts TCGplayer servers and never stores or uses TCGplayer
auth cookies or credentials.

## Immutable Inputs

The closed schema is defined once by `parseManifest` in
`scripts/bootstrap-db-oracle-memo-artifact.mjs`. Capture-successor manifests use
this schema, not an independently defined variant. The JSON must be UTF-8,
two-space indented, LF terminated, without duplicate or unknown keys. Its maximum
size is 256 KiB; GitHub's dispatch input limit may impose a smaller transport
bound. Compute the reviewed SHA-256 over those exact bytes, including the LF.
Never alter a reviewed manifest to repair a failed run without renewed review.

| Field | Binding |
| --- | --- |
| `schema`, `repository` | `bootstrap-db-oracle-memo-input/v1`, `chase-sets/chase-sets` |
| `S`, `W`, `E`, `T`, `D` | Each has exactly `commit` and `tree`, full lowercase Git SHAs |
| `R` | String `runId`, integer `attempt: 1`, string `currentJobId`, `pairedJobId` |
| `fixtures` | `current`, `paired`, `baseline`, each exactly `path` and accepted file-byte `sha256` |
| `checkerLiterals` | Exactly the five exported literal declarations named by `LITERALS` |
| `inputDelta` | Sorted unique `{path,beforeSha256,afterSha256}`; absent old file uses `null` |
| `readClosureSha256` | SHA-256 of binary `git ls-tree -rz --full-tree E` output |
| `toolchain` | `node: v24.22.1`, `pnpm: 11.0.9`, E's `pnpm-lock.yaml` file-byte `lockSha256` |

`S` is the final product source. The accepted capture child `W` has sole parent
`S` and adds only the capture workflow. `E` descends from `S` and changes only the
accepted current/paired fixtures, canonical workload baseline, and authorized
checker literal initializers. The old memo remains unchanged. The manifest
binds every changed byte and the complete tracked source tree. Producer and raw
oracle remain byte-identical to the route's pinned baseline. Checker syntax
outside those initializers is byte-identical, and the initializer parser admits
only data and `Object.freeze`, never executable overlays.

The fixture paths are `bootstrap-db-capture-R.json`,
`bootstrap-db-capture-R-paired.json`, and `db-enrollment-workload-R.json` under
`deployables/platform-api/__tests__/fixtures/`, where R is the capture run ID.
Their accepted digests are host facts, not raw artifact ZIP digests. No capture
artifact is downloaded by the derivation job.

`T` is the reviewed route commit already on main. If `E` already contains T's
workflow blob, `D = E`. Otherwise `D` is a nonmerged sole child of E adding only
that workflow, byte-identical to T. Dispatch D, while separately checking out
helper T and input E. Do not dispatch raw S or W, substitute current main, or
guess the later publication commit's hash.

## Host Lifecycle

1. After route landing, read the actual workflow registration ID, path and
   active state. Run `node scripts/bootstrap-db-oracle-memo-artifact.mjs preflight`
   from helper T. This is read-only and refuses incomplete pagination, disabled
   registration, and any queued, requested, waiting, pending or in-progress run.
   Perform it immediately before the single authorized dispatch. Coordinate the
   host's single writer: GitHub concurrency is only a backstop, since it can
   cancel an older pending run even with `cancel-in-progress: false`.
2. Under the capture owner's existing authority, review E and its manifest,
   then dispatch `.github/workflows/bootstrap-db-oracle-memo.yml` on D exactly
   once, supplying `helper_sha=T`, `input_sha=E`, `manifest_json` and
   `manifest_sha256`. No lane automatically dispatches, retries, reruns, cancels,
   applies or recaptures. The workflow uses only `contents: read`, nonpersisted
   checkout credentials, standard `ubuntu-latest`, and a fixed 30-minute ceiling.
3. The job validates immutable objects before candidate imports, installs frozen
   dependencies without lifecycle scripts or pnpmfile hooks, verifies clean E
   and W1-W5 against its baseline, and runs only the fixed unchanged producer
   from `deployables/platform-api`. All tracked read-closure files are hashed
   before and after. Only the memo may change. Native producer, validator or
   upload failure fails the job; there is no derivation-PASS substitute.
4. Wait until COMPLETED attempt 1. From helper T, set `MEMO_MANIFEST_JSON` and
   `MEMO_MANIFEST_SHA256` to the reviewed values, then run
   `node scripts/bootstrap-db-oracle-memo-artifact.mjs accept RUN_ID ARTIFACT_ID`.
   This reads bounded completed-attempt jobs and artifact metadata, downloads the
   memo artifact, checks the outer digest, and joins `deriveMemo`'s receipt
   check-run ID to the numeric job. Every required producer/validator/upload
   step must have executed successfully. Retain the returned run/job URLs,
   artifact ID/digest, memo/receipt/sums digests and original downloaded bytes.
   No mid-run job or PR inference is authority.
   Derivation requires unmerged E; read-only acceptance/application may inspect
   historical E after publication lands, without authorizing another derivation.
5. The canonical author alone copies the accepted memo into P and updates the
   ordinary enrollment test pin. Run the read-only application probe from T:
   `node scripts/bootstrap-db-oracle-memo-artifact.mjs application P RUN_ID ARTIFACT_ID`.
   It reaccepts the completed artifact, checks P's memo bytes and equality of
   producer/oracle/checker/fixtures with E, and explicitly leaves hosted proof
   pending. It never writes or grants publication/landing authority.
6. Require exact-P hosted enrollment assertions with zero exits and the selected
   `Bootstrap DB Oracle Memo Check` job. The latter executes the raw CLI
   `node deployables/platform-api/__tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs --check` once,
   independently of Unit shards, under a 30-minute bound. Preserve its job/head,
   raw command and zero exit in durable logs. The same selected check must pass
   in the merge group. Any W1-W5 drift stops; other read-closure movement from E
   needs both raw checks, else re-derive. The application probe is not that proof.
7. The first accepted derivation and first consumer check are post-landing host
   evidence, not prerequisites invented or simulated by the route lane. Keep
   them `PENDING_HOST` until observed. On the consumer, retain a hosted one-byte
   corruption negative proving the independent raw check rejects wrong bytes;
   restore the accepted bytes before qualification. Existing Unit assertions,
   its 20-minute bound and complete 4,095-key corpus remain unchanged here.

## Artifact And Stops

There is exactly one canonical artifact containing exactly
`bootstrap-db-oracle-schedule-memo.json`, `receipt.json`, and `SHA256SUMS` at its
root. Upload follows successful producer and validation, with exact paths and
`if-no-files-found: error`. Diagnostics never satisfy canonical presence. The
receipt binds S/W/R/E/T/D, trees, literal values, input/pair digests, workflow/ref,
run/attempt/job key/check-run, helper/input checkouts, runtime and timestamps.
The validator requires the exact ordered 4,095 `[workers,durations]` keys, pinned
oracle, canonical JSON/LF and stdout/file digest equality. Sums bind both JSON
payloads; the outer artifact digest binds the complete archive, including sums.

Limits: memo 1 MiB, receipt 2 MiB, sums 4 KiB, compressed ZIP 4 MiB, twelve
scheduled files. The ZIP reader rejects partial, extra, duplicate, traversal,
link, encrypted, oversized, overlapping or corrupt entries. Historical capture
artifacts and schemas are unchanged.

Stop to the host on wrong head/input, dirty checkout, changed read closure,
stale or conflicting profile, W1-W5 drift, producer failure or nondeterminism,
missing/expired/partial artifact, unknown authority, or budget overrun. Equal
scheduled durations can collapse oracle keys and legitimately stop the unchanged
producer; never widen the envelope or change the algorithm to admit them. Do not
raise bounds, skip assertions, signal processes or reinterpret a refusal as PASS.
No local producer or raw oracle check is authorized. Local admission and verifier
policy remain unchanged; exit 73 means `NOT_EXECUTED`. Paid runners, credentials,
provider access or expanded authority require a new decision, not a fallback.
