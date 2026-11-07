# Runner-Local Ingress Diagnostic

Temporary, synthetic, **DO NOT MERGE** test support for [#10678 Fix staging Admin-origin catalog generation edge routing](https://github.com/chase-sets/chase-sets/issues/10678). This is not a production repair, staging probe, controller release proof, or live acceptance receipt. The [host-concurred B ruling](https://github.com/chase-sets/chase-sets/issues/10678#issuecomment-6703833284) changes execution location only. No local harness/container/cluster execution is authorized. Chase Sets never contacts TCGplayer servers and never stores or uses TCGplayer auth cookies or credentials.

## Host Job Contract

The host alone authors `.github/workflows/platform-pr.yml`, audits **all** other PR-triggered workflows for unintended deploy/provider behavior, freezes the combined bytes, and obtains fresh independent review before publication. Preserve existing required gates and workflow concurrency. Do not push while capture runs. No dispatch, automatic retry, rerun-to-green, merge queue, auto-merge, environment, deploy workflow, secrets or OIDC.

1. Exactly one `ingress-nosend-diagnostic` job, `ubuntu-24.04`, `timeout-minutes: 30`, job `permissions: { contents: read }` only. No self-hosted/preview/staging runner. Gate on `pull_request`, draft=true, same-repository head `chase-sets/chase-sets`, exact branch `host/10678-ingress-nosend-diagnostic`. Exclude `merge_group`, arbitrary refs and dispatch inputs.
2. Checkout `github.event.pull_request.head.sha`, not the synthetic merge SHA, with `persist-credentials: false`. Retain immutable base/head/merge separately. Pin actions by commit. Existing repository action pins are checkout `df4cb1c069e1874edd31b4311f1884172cec0e10` and upload-artifact `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`; host verifies their public provenance before reuse.
3. Preparation installs only reviewed public tools, obtains the public chart tarball and retained ConfigMap capture, and supplies the freeze JSON described below. Expected digests are reviewed constants, never hashes automatically accepted from whatever the runner downloaded. No private image login, cloud credentials, DB/provider boot, live-object fetch or chasesets.com DNS lookup.
4. From the repository root, run the pinned Node binary with `scripts/test-support/10678-ingress-nosend/runner.mjs prepare <absolute-freeze-json>`. Then a **separate foreground step with `timeout-minutes: 10`** runs the same entry point with `measure`. Both must succeed in order; no `continue-on-error` can turn an incomplete matrix into a pass. The runner checks elapsed time too, but only the workflow step bounds a stuck child. This is an orchestration ceiling, not a changed Node/nginx timeout. A phase timeout is PARTIAL/UNKNOWN, never a smaller passing matrix.
5. An `if: always()` foreground capture step runs `seal` with the same inputs, even after failure. Before upload, independently require seal success and parse `publication-gate.json`: `publish`, `complete`, `captureComplete` must all equal true, `scan` must be `NO_HITS`, and its manifest hash must match. A missing gate blocks upload. Upload only the exact diagnostic directory, never its parent/private sibling or a broad glob. Use the pinned artifact action with `if: always()` **and** that verified publication condition, `if-no-files-found: error`, no include-hidden-files, no overwrite. A scan hit returns file/line only and blocks all publication. Do not print raw files into job summaries/comments.
6. Host captures exact executed job/step conclusions and timings, run ID/attempt, numeric job ID, upload artifact ID/digest and receipt hash from the owning job, not overall workflow success. Download full attempt-specific logs to a private host file before bounded inspection. Reconcile complete job/step collections. The post-upload custody record is external to the immutable artifact to avoid a self-digest cycle. It binds artifact ID/digest to the artifact's `receipt.json` hash and records runner completion/disposal. An artifact name or wrapper green is not execution proof.

## Inputs

Required runtime environment is `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`, `GITHUB_JOB=ingress-nosend-diagnostic`, `GITHUB_EVENT_NAME=pull_request`, `GITHUB_EVENT_PATH`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_SHA`, `RUNNER_TEMP`, and `DIAGNOSTIC_FREEZE_SHA256`. Optional `DIAGNOSTIC_JOB_ID` is accepted only as a numeric observed owning job ID; otherwise the local receipt explicitly records `PENDING_HOST_ATTEMPT_SPECIFIC_JOB_AUTHORITY`, never a guessed ID. The run/attempt/job-key tuple binds the local capture. The host must supply the numeric ID and reconcile complete attempt-specific job/step collections in the external post-capture custody receipt. Do not assume the repository's jobs API is public or grant Actions permission/token access to obtain it inside this contents-read-only job. Host post-capture reconciliation is mandatory even when the numeric ID was supplied. Do not place a GitHub token in the harness environment. `DIAGNOSTIC_FREEZE_SHA256` is the independently reviewed freeze file's SHA-256. Run as the normal non-root hosted user; only specific firewall operations use pinned `sudo -n`.

The UTF-8 freeze JSON is external to the repository, contains no credentials, and has these required fields:

```text
schema: 1
head: exact 40-hex reviewed PR head
briefSha256: protocol.json's governing body hash
methodSha256: protocol.json's method report hash
review: { verdict: "PASS", head: same exact head, receiptSha256: canonical review receipt hash }
files: { repository-relative path: lowercase SHA-256, ... }
tools: { tool name: { path: absolute real executable path, sha256: reviewed lowercase SHA-256 }, ... }
chart: { path: absolute cached ingress-nginx-4.11.3.tgz path, sha256: reviewed archive SHA-256 }
retainedConfigMap: { path: host-supplied absolute retained capture path }
images: {
  kind: immutable kind node image reference,
  historical: immutable public Node 24 bookworm-slim image reference,
  current: immutable public source-stack Node image reference,
  prefetch: [every image reference, including those three and every rendered chart image]
}
```

All image references must include `@sha256:<64 lowercase hex>`. `files` covers every file in this directory, `scripts/render-platform-helm-values.mjs`, `scripts/lib/repo.mjs`, `scripts/doks-cluster-addons.mjs`, `infrastructure/helm/doks-ingress/ingress-nginx-values.yaml`, `pnpm-lock.yaml` and the host-authored workflow. Add any host-added imported file. The source stacks are immutable Git objects already present in the full checkout; there is no dynamic ref fetch or shallow fallback. All Helm chart/template and dependency inputs for each source are bound by its Git ref, source archive, lockfile and execution-time esbuild import closure.

Tool keys are `node`, `git`, `tar`, `docker`, `kind`, `helm`, `kubectl`, `pnpm`, `esbuild`, `yq`, `openssl`, `sudo`, `iptables`, `ip6tables`, `ip`, `systemctl`. Pin actual executable bytes and public distribution/version references, including script interpreters where applicable. The runner records actual versions. Use repo-compatible pnpm (current source specifies 11.0.9) and esbuild (current source specifies 0.28.1). `yq` must be Mike Farah v4 with `eval-all -o=json -I=0 '[.]'` support. No PATH shim. A tool digest or binary availability unknown is a prerequisite failure, not permission to accept it at runtime.

The retained ConfigMap file must hash to `a9c196c3ed04ff4e2612052597296d9b898bddbdae1649eaedc047591b8bec52` and parse as one ConfigMap. Its location is deliberately not guessed. Compare complete data to the chart-rendered ConfigMap, normalizing **only** the approved local error-log path/level. Any extra/missing override stops before generate. Unknown historical Node patch stays UNKNOWN; actual test image/Node versions are measured, not claimed to recover history.

## Preparation And Isolation

Each source is extracted separately, installed with its frozen pnpm lock and lifecycle scripts disabled under an empty credential/config home, then bundled with its actual Hono/adapter, `createHonoObservabilityMiddleware` and `startGracefulHttpServer`. All non-builtin imports must be included by esbuild. The runtime receipt hashes every bundle input, output and lockfile. Nothing imports the production composition root or boots DB/provider services. The synthetic logger adds distinctly labeled application traces; it does not invent an nginx/shared response ID or alter middleware timing.

The runner prefetches every digest-bound image and loads chart/runtime images into kind before measurement. Kind's digest-bound node image supplies its embedded Kubernetes/system images; complete containerd inventory/imageIDs are captured before the first row and must remain unchanged. Any pending pull, restart, missing imageID, changed inventory or unavailable log stops. Actual Node socket timeout defaults are logged, not configured. No injected close, modified server timeout, compact/async response, extra rung, duration search or generate retry exists.

One run/attempt owns `nosend-<run>-<attempt>`, a dedicated `172.29.0.0/16` Docker bridge, local-only kubeconfig/context/API `https://127.0.0.1:16443`, and all cluster/resources. No default context or external endpoint fallback. The job uses the real chart 4.11.3 and repo values, preserving defaults, custom errors/default backend and ssl-redirect. Only accepted behavior deviations are NodePort/no DO annotations, no hostPort, self-signed verified TLS, and local `/dev/stderr` info/warn logging. Run labels and synthetic control resources provide identity, not an ingress behavior override. The repository platform chart renders the two Admin-matching stable Ingresses, with selector-less Services/EndpointSlices to local synthetic backends; `/` has a distinct 418 control backend so it cannot masquerade as `/api`.

Before any generate, rootful Docker and the run-owned bridge are bound. IPv4/IPv6 host INPUT and pre-Docker FORWARD rejection rules stop host/NAT escape from nodes, pods, backends and clients. Root-owned host DNS OUTPUT rejection also covers Docker's embedded-DNS forwarding; the non-root runner/artifact channel remains outside the measured boundary. Local positive TLS route, an actually reachable-before-boundary host sentinel, reserved `198.18.0.2` routed-egress rejection, `.invalid` DNS rejection and nonzero firewall counters prove controls. A Node control pod independently exercises the cluster path. No negative control contacts a real provider. If a runner's rootless/resolver/firewall configuration does not satisfy these controls, stop before payload, do not weaken the boundary.

The measured URL always retains `admin.staging.chasesets.com` as Host/SNI, but the client supplies an explicit numeric local connection lookup and verifies the generated CA. It never asks an OS/public resolver for that hostname and never disables TLS verification. Public download/registry traffic happens only during preparation. Never use this hostname as an address in an unqualified curl/browser/DNS command.

## Protocol And Outputs

`protocol.json` fixes one logical baseline round: historical `edddac45d0885dbb32432486f48e23968402a50c` / adapter 1.19.17, then current `b3df7dfba984aee859c064cc00211ed83e41bee5` / adapter 2.1.6. Per stack run 1, 100, 302, 1000 candidates at middleware-measured 12005 ms +/-25 ms, then the 302-candidate 100 ms control. Record actual response bytes; no rung claims attempt-one size equality. One foreground sequence, never a parallel Actions matrix. A row is persisted before dispatch; rerunning prepare or measure on existing state is refused.

Output is exactly `$RUNNER_TEMP/10678-ingress-nosend/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT/diagnostic`. Its private sibling contains kubeconfig, TLS key, source installs, bundles and state, and is **never** uploaded. Captures are flat files:

1. `exact-run-inputs.json`, phase start/completion markers, rendered/effective values/configuration, all local routing/workload/pod/event/image inventories, complete per-pod `--tail=-1` controller access/error and application logs, and `nginx -T` configuration/reload evidence.
2. Numbered command stdout/stderr captures and `command-ledger.json`, bundle metadata plus source/dependency import-closure hashes, exact per-row client headers/TLS/socket/body/write/end/close and real middleware completion. Captures are not truncated or tail-capped. Correlation records UTC/path/backend/container/pod and distinct nginx ID/application trace, not a fabricated shared header. Socket bytes/hash must agree for delivered-202 proof.
3. `receipt.json` contains all ten rows, measured duration/bytes, classification, source/run/attempt/job identity and phase state. `raw-manifest.json` hashes every prior raw file and receipt; `publication-gate.json` binds the manifest hash and private raw/decoded-body exposure scan. Missing/duplicate/unparseable/capped evidence is UNKNOWN and blocks publication. A complete negative result is not a product PASS.

Neither stack showing 502/zero upstream bytes plus app-202 stops the round for the governing host decision, without retries, waiver, staging or frozen logging-window re-entry. Old-only signature nominates the already-landed adapter bump **only** if every current rung/control delivers the exact app 202; live release binding must still contain `76cf718a845269f521678527bcba37f04d3935ce`. Current-stack signature requires raw mechanism review and one evidence-selected in-footprint repair or a separately accepted outside-fence issue. The signature alone is not a timeout/retry/close mechanism claim. Before any row, failure is NOT_EXECUTED; after dispatch, incomplete execution is PARTIAL/UNKNOWN and requires host disposition, never a reset or rerun.

This entry point admits only the frozen baseline refs. It deliberately does not admit an arbitrary candidate ref, replay or second baseline. Any later candidate-source binding is a host-owned, freshly reviewed update within the **same logical round**, using this unchanged finite protocol and comparison evidence; it must not rerun the unchanged baseline. This lane grants no candidate execution authority. Preserve every pushed/reviewed/CI head in consumed-head history. Close the diagnostic PR unmerged after custody/disposition; never land these files/workflow.

All live acceptance remains outside this harness: host off-state/serving release and all live stable/canary objects/logs, accepted AC1/AC2, selected repair merged **and serving**, all-rung/control proof, then the sibling-owned single same-origin request only. AC3 response/correlation is independent of the sibling catalog verdicts; all sibling AC4(a)-(h), source-owner/freshness/history/no-sync/no-resend constraints remain unchanged. Scratch parent and frozen logging window stay barred. EX-1 is a separate nonblocking historical exposure investigation, not a classifier that may be inferred from this synthetic run.

No process/container stop, signal or recursive deletion is issued by this runner. The disposable hosted runner owns final resource disposal. Host records actual runner/job completion and resource disposition; uncertain teardown is UNKNOWN, not a claimed cleanup PASS. Preparation/measurement capabilities must be observed immediately before payload; artifact/job authority is bound at capture; later live serving/off-state observations remain at the sibling lifecycle moment.

## Focused Checks

Only pure helpers may be run locally:

```powershell
node scripts/test-support/10678-ingress-nosend/helpers.check.mjs
```

No file is named `*.test.mjs`, and the check imports no runner, handler, Docker/cluster API or network client. Keep ordinary scoped formatting/comment checks; hosted exact-head CI owns product proof. Full/harness/DB diagnostics are optional, never publication gates. Local heavy admission refusal 73 is NOT_EXECUTED, never PASS or a consumed attempt, and never escalates to a full gate. Product CI is not controller-release-battery proof. Do not raise timeouts, weaken checks, relabel incomplete evidence, reopen logging, or contact staging/providers to repair a diagnostic failure.
