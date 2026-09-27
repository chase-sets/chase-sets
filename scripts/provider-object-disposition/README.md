# Guarded TEST lifecycle capture

This is operator tooling, not a deployed service or a CI provider path. Importing
the modules and running either bare entrypoint refuse without opening a session.
Landing the tooling does not qualify replay or satisfy #6734 AC-08.

## Execution Boundary

The installed route requires Linux, a non-root principal, and the exact native
launcher at `/usr/local/lib/chase-sets-provider-window/launcher`. The only installation
authorized by this change is the ephemeral GitHub-hosted `ubuntu-24.04` Static
Checks job. Operator installation and authority are separately owned by #8364;
the operator entrypoint refuses this CI-only admission before private input or
credential entry. A CI environment flag or receipt cannot enable an operator.
Unsupported and unprovisioned hosts, including Windows, refuse without fallback.
Admission first probes the same installed boundary without a browser.
Failure diagnostics distinguish this predicate from sandboxed Chromium startup and
report closed system error class/message/errno plus the observed AppArmor user-namespace
restriction (0, 1 or unknown). Arbitrary launch output, argv and child errors are
never retained. Diagnostics authorize no sandbox or namespace fallback.
Browser routing alone is insufficient: the child has fresh user/network/PID/mount/
IPC/UTS namespaces, no external interface, and a down loopback interface. Only the
parent can fetch the exact public loader, with
manual redirects, no cookies/referrer/authorization and bounded bytes/deadline.
Frames, workers, alternate clients and background traffic cannot use the host's
network namespace. The browser's root contains only immutable, identity-bound
Chromium/resources/libraries/fonts and closed device nodes. Private `/proc` sees
only this launch; `/tmp` and `/dev/shm` are per-launch tmpfs mounts. There are no
host home directories, Unix services or host namespace handles in that root.
The non-root browser drops capabilities and their bounding set and sets
`no_new_privs`; Chromium's nested user-namespace/seccomp sandbox remains enabled.
Node implements its automation pipes as unnamed Unix socketpairs. The launcher
validates their principal/parent peer and relays only those opaque automation
bytes to real POSIX pipes; Chromium inherits no host socket. Its stdio is null,
environment is closed, and neither native nor browser core dumps are allowed.
Namespace PID 1 reaps owned descendants; parent-death signals and the kernel's
PID-namespace disposal also drain double-forks on force termination. Profiles
exist only on the namespace-owned tmpfs, not in a persistent host directory.
Inherited Node preload hooks cause pre-child refusal; the entrypoint never strips
or bypasses a machine-admission hook to obtain provider authority.

The future host must package the **exact landed and independently reviewed head**,
its successful hosted/DB evidence, one digest-bound closed manifest and private
pre-existing TEST fixtures. Do not substitute a branch, prior PR review, generated
synthetic fixture, environment flag or command switch for operator authority.

### CI Installation

`browser-boundary/install-ci.sh` is the privileged CI setup/owned teardown, not
an operator command. It snapshots sources and the Playwright-pinned browser,
resolves ELF dependencies without executing them, compiles a static native
launcher, and loads one exact AppArmor attachment. All installed code and path
components are root-owned and non-writable by the admitted principal. The launcher
is mode 0750, restricted to that non-root UID/GID, with no set-ID or file capability.
The input snapshot and installation use `/usr/local/lib`, not the hosted image's
world-writable `/opt`. Setup and installer guards emit closed stage/refusal codes;
unknown command failures retain the active stage and fail the job. Parent-path
ownership and modes are verified, never repaired by widening or overriding them.
Both modes validate the source digest, launcher, full dependency inventory and
effective label before namespace creation. Closed modes accept no executable,
profile path, browser flag or command. The AppArmor profile supplies only the
application-specific user-namespace permission; it is not the network fence.
Root/runner administrators are the trusted setup boundary, not adversaries defeated
by mode 0750. They must not mutate the installation while controls are running.

Setup runs serialized real missing/wrong attachment, stale source, tampered
dependency, wrong-argv, disallowed-principal and unprofiled-comparison controls,
then the positive probe. Inputs not under test stay fixed. No mutant launches an
unfenced browser. A changed runner image/kernel gets fresh proof. Setup/control
failure is a failed job, not synthetic success. The workflow's `always()` step
removes only this installation/profile. On runner loss, VM disposal is the outer
boundary, not a claim that the cleanup hook succeeded. No sysctl or global
AppArmor policy is modified, and no provider credentials or OIDC are supplied.

The required command shape is:

```text
pwsh -NoProfile -File <absolute-landed-invoke-test-window.ps1> -CandidateHead <40-hex> -ManifestPath <absolute-manifest> -ManifestSha256 <64-hex> -AuthorizeOneTestWindow
```

The entrypoint checks the actual PowerShell parent command and clean exact head.
It displays the head/digest, requires their exact non-echoing confirmation, and
atomically consumes the authorization record. Fixture input is private and
replacement-bound. Browser confinement and an empty, isolated local PostgreSQL
database are checked before the non-echoing TEST-key prompt. Do not put keys,
private references or fixture material in arguments, repository env files,
manifests, transcripts or GitHub. No key is sent to the browser.

`validateLaunchManifest` in `test-window-admission.mjs` defines all closed fields.
`configurationDigest` and `POLICY_DIGEST` bind the selected v2 strategy, shared API
version, SDK 3.4.5 wrapper and executable policy. The wrapper pin does not pin
remote `connect.js`. A manifest may tighten budgets, not authorize another URL.
Configuration and policy versions use the exact executor Git revision, rather
than introducing another provider/schema version.
The four schedule memberships and fixture digest must match the private inputs.
Claim and packet parents must already be private, user-owned directories outside
the checkout; they cannot be symlinks. The J database must be local, empty,
unshared and named for this window. Its state is retained, never dropped by capture.

## Lifecycle

P covers one Customer for buyer A, one embedded SetupIntent and one saved-method
PaymentIntent using pre-existing Customer B. S, M and N each cover one Connect
slot in a separate predeclared journal window. Each flow opens, runs, disposes,
validates its own receipt and CAS-closes before the next opens. Three sessions in
one window still fail the existing class-6 budget of two. No account/contact-email
write, setup shortcut, account enumeration or unbudgeted provider preflight exists.

Accepted responses are withheld, then replayed once after five seconds through
fresh gateways and a fresh adapter over the same persisted J. Exact request and
response digests, keys, versions, deadlines and UTC instants stay distinct from
provider usability. The P disposition attempts a concurrent cancel pair, lost
response reconciliation and terminal repeat without a fresh key. A captured PI
retains its remedy obligation; it is never relabeled cancellable or refunded by
this tool. Customer identity reuse remains persistent and counted once.

Unqualified repeat/two-tab requests cannot suppress the separately scheduled
component initialization. The actual SDK wrapper entrypoints run with designated
transient replay material. A second callback refuses. No common sufficient
provider-ready signal is available for all three components, so this adapter
reports usability **unknown**, even after creation, mount or loader-start. An
uninvoked stage is missing, not a policy-negative provider finding. There are no
clicks, inputs, submissions or account writes in the production observer.

## Evidence And Failure

The parent publishes only after the credentialed child exits. A closed packet and
its digest are written in a partial directory and exposed together by rename.
Partial directories are not completed evidence. Interrupted execution is invalid;
the consumed claim and persisted J remain for the host's bounded cleanup handling.
There is no restart, renewal or automatic retry. Expiry/caps stop scenario/browser
work without lending them the disposition reserve. Unknown counts are never zero.

Receipts retain observed dev/test/staging vocabulary. The canonical receipt's test
fallback for production/absent pre-network refusals is a legacy convention, not
observed TEST authority. Admission separately refuses staging/live/unknown mode,
and provider responses require `livemode=false` before positive observations.

Do not collect raw browser traces, page text, screenshots, HTTP bodies, errors,
URLs or headers. Denials use only the 80 closed method/origin/path buckets.
Keep `replayQualified=false`. The host still owns post-process redaction review,
lifecycle/interval acceptance and #6734 AC-08. A five-second replay is not 23-hour
evidence, and a blocked initialization is not inherent provider unusability.

Any additional browser form, including a GET, requires separately authorized
semantic/request-form evidence, an independent decision, reviewed hosted-green
code and fresh digest-bound operator authority. SDK changes, loader contents,
CSP origins, wildcard origins and denial observations cannot widen this fence.

## Credential-Free Controls

The `test-window-*.test.mjs` tests use labeled synthetic identities, SDK stimuli
and transports. `test-window-browser.test.mjs` exercises the real confined browser
adapter; it requires the supported Linux capabilities, not a mock browser. Hosted
Static Checks installs the native boundary and Chromium for these controls, never invokes the authorized
launch and never contacts Stripe. `provider-journal.db.test.ts` exercises actual
registration, persistence, gateways and disposition; hosted DB Profile Tests are
the final-head DB proof. Synthetic observations never qualify real sessions.
