# Route-collision parity

`scripts/route-census/run.mts` is the independent, exact-head oracle for the resolved context-mount route census and the complete `buildPlatformApiApp` route assembly. It publishes one recursively validated base/candidate artifact. It does not enforce product behavior, infer route intent, keep a golden, or expose separate capture/compare commands.

## Commands

```powershell
pnpm exec tsx scripts/route-census/run.mts parity --base-root <path> --expect-base-head <40hex> --candidate-root <path> --expect-candidate-head <40hex> --expect-harness-head <40hex> --expect-comparison <empty|nonempty> --out <new-path>

pnpm exec tsx scripts/route-census/run.mts validate --artifact <path> --expect-base-head <40hex> --expect-candidate-head <40hex> --expect-harness-head <40hex> [--expect-base-root <path>] [--expect-candidate-root <path>]
```

`parity` requires canonical, clean, separately rooted Git worktrees and exact lowercase heads. The harness checkout is independently bound by `--expect-harness-head`. `--out` must name an absent file in a writable sibling directory; there is no overwrite or force mode. `validate` is read-only and never acquires the heavy slot.

Exit codes are closed:

- `0`: the complete artifact is valid and its comparison matches the requested state.
- `1`: `E_EXPECTATION_MISMATCH`; no artifact is published.
- `2`: a named usage, environment, provenance, schema, capture, validation, or publication failure.
- `73`: the production heavy-admission client refused the process. This exit is not caught or translated.

## Target-root capture

Each evaluation child runs with the target root as `cwd`, its `tsconfig.json` in `TSX_TSCONFIG_PATH`, `NODE_ENV=test`, and the app call `buildPlatformApiApp(runtime, { runtimeProfile: "public" })`. The two profile facts remain separate artifact fields: `nodeEnvironment:"test"` and `appRuntimeProfile:"public"`.

All absolute Windows module paths are converted with `pathToFileURL`. The generated API registry, `infrastructure/bounded-context-runtime/api-mounts.ts`, and `deployables/platform-api/src/app.ts` are imported from the evaluated tree. A bare-specifier probe and effective-tsconfig evidence must realpath below that same root.

The evaluator obtains `mergePath`, `checkOptionalParameter`, `splitRoutingPath`, and `getPattern` from one target package-export namespace for `hono/utils/url`. The module realpath, package version, module SHA-256, and four-member helper surface are retained and revalidated. No host-tree helper or recalled Hono grammar participates.

The census mechanically traverses every platform-api context, mount, router, and public route in registry order. Every mount produces a `mountRecord`, including zero-route mounts, and `scanned` must equal `total`. The closed entry unwrapper accepts only the current positional router or the exact successor `{mountPath, contextMountOrdinal, router}`; keyed declarations are within-capture validation, while position remains the census ordinal.

## Collision projection and shared vector

For each route, the primitive `mountPath` and `rawPath` are retained. `combinedPath` is exactly target Hono `mergePath(mountPath, rawPath)`. The full combined path then passes once through `checkOptionalParameter`; a `null` result means `[combinedPath]`, while an empty result is `E_ROUTE_PATTERN`. Every returned accepted path passes independently through `splitRoutingPath` and `getPattern`. Parameter names—including `?` bytes treated as name data—are erased to one-based `:pN`; exact custom-pattern bytes, wildcards, root paths, brace-contained slashes, and trailing empty segments are retained.

The stored `acceptedPathProjections` and ordered structural `collisionShape` are recomputed from primitives during publication and `validate`. Optional branches remain one route-level shape. Unknown colon-leading grammar fails indeterminate by construction. Artifact `grammarCoverage` mechanically partitions every derived segment into empty, literal, wildcard, colon-parameter, or indeterminate; a valid artifact has no indeterminate member.

`collisionFixtureVector` in `collision-path.mts` is executable and embedded byte-for-byte in v4 artifacts. It covers mount slash boundaries (including R0313 as `/api/customer-feedback`), optional/custom lifecycle behavior, brace patterns containing `/`, equal/different custom patterns, parameter/literal distinctions, non-leading colons, wildcards, trailing slashes, malformed patterns, empty expansion, and Hono's nonempty surprising optional expansion. Downstream #6324 imports and deep-compares this vector; it must not copy or locally adjust expected collision data.

## Stable groups and comparison

A duplicate group exists when at least two census rows have structurally equal `(method, collisionShape)`, including `ALL`. `D001...` is an ordinal display label only. Group membership is the sorted occurrence/count multiset of:

```text
(context, mountPath, method, rawPath, combinedPath, collisionShape, handler.name, handler.arity)
```

Capture positions, declared/derived ordinals, row indexes, display IDs, handler reference IDs, attached-reference equality, and source digests are diagnostics, not group or cross-capture identity. Group diffs align the sorted union of `(method, collisionShape)` and emit exactly one `added`, `removed`, or `changed` record. An identical third occurrence changes its count instead of disappearing into a set.

Mount, census, and assembly sequences use the deterministic shortest-edit script over input order. Repeated anchors align left-to-right; equal-cost ambiguity removes before adding. Census anchors are `(context, method, rawPath, collisionShape)` and assembly anchors are `(basePath, path, method)`. Position-only and positional-to-keyed changes do not become semantic changes.

The assembly boundary is closed by D-A8: `mountedBlockStart = assemblyRecords - censusRecords`; the final census-sized tail matches ordered `(method, combinedPath)`, every tail row has a declared mount `basePath` and the same handler reference, and no pre-mount row falsely qualifies.

## Artifact and lifecycle

The only accepted schema is `chase-sets-route-parity/v4`. Every object is recursively closed, collection/numeric/duration fields are bounded, timestamps require a timezone, primitive/source hashes are conserved, and every count, projection, group, boundary, and diff is recomputed. v2/v3 artifacts are rejected and never upgraded. v4 base and candidate captures may retain different causally eligible target versions; each side is validated against its own exact root/head without fabricated lineage.

After all preflight succeeds, the parent calls `acquireHeavySlot("script-battery")` once. The accepted parent owns the base child, candidate child, comparison, recursive validation, and publication. Descendants inherit the controller token. There is no release, reacquire, retry, wait, stale-owner cleanup, or lock mutation; the controller releases only its own owner after the guarded process tree exits.

The completed artifact stays in memory until recursive validation and expectation matching finish. Publication uses one random sibling temporary file opened exclusively, writes the exact payload, flushes, closes, and atomically renames it. Failure removes only that owned temp and leaves no artifact residue; a preexisting sentinel is never changed. A nonempty directory, missing/wrong/duplicate/malformed JSON payload, nested unknown field, or stale head/root/hash is not a canonical artifact.

Day-after operation always creates a fresh head-plus-run-ID path for the exact base/candidate/harness identities and validates that same file. Never reuse a previous run path or treat directory presence as evidence.

## Literal #6324 consumer workflow

The downstream product slice uses this exact shape with a new GUID every run. Its product change expects a nonempty comparison and validates the same unique payload:

```powershell
$env:BASE_HEAD = "the exact 40-hex sha of the lane base commit"
$env:CANDIDATE_HEAD = "the exact 40-hex sha of the committed PR head"
$env:RUN_ID = "$env:CANDIDATE_HEAD-$([guid]::NewGuid().ToString('N'))"
$env:PARITY_OUT = Join-Path $env:TEMP "route-census\$env:RUN_ID\parity-$env:BASE_HEAD-$env:CANDIDATE_HEAD.json"
pnpm exec tsx scripts/route-census/run.mts parity --base-root ..\route-census-base --expect-base-head $env:BASE_HEAD --candidate-root . --expect-candidate-head $env:CANDIDATE_HEAD --expect-harness-head $env:CANDIDATE_HEAD --expect-comparison nonempty --out $env:PARITY_OUT
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm exec tsx scripts/route-census/run.mts validate --artifact $env:PARITY_OUT --expect-base-head $env:BASE_HEAD --expect-candidate-head $env:CANDIDATE_HEAD --expect-harness-head $env:CANDIDATE_HEAD --expect-base-root ..\route-census-base --expect-candidate-root .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The base worktree must have dependencies installed and remain at its immutable exact head. Run this literal block twice only with two new output paths; a failure stops before validation, so no stale artifact is consumed.
