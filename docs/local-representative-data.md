# Local Representative Data

Use this guide to assemble a disposable local marketplace over accepted Catalog Observation Packs. The result uses the real Catalog replay, promotion, asset, commerce, projection, API, and Marketplace UI paths; it does not call a provider or copy staging or production data.

This is the developer workflow. For pack governance and storage, see [Seed Pack Storage](./runbooks/seed-pack-storage.md). For the separately controlled staging operation, see [Staging Representative Commerce State](./runbooks/staging-representative-commerce-state.md).

## Prerequisites and profile

Install dependencies, inspect the worktree-owned sandbox, and set an absolute path containing one to four complete accepted pack directories:

```powershell
pnpm run deps:install
pnpm run sandbox:doctor
$localProofCredentialPattern = "^(RELEASE_EVIDENCE_SPACES_|SEED_PACKS_SPACES_|DIGITALOCEAN_|DOCTL_|TF_VAR_digitalocean_token$|AWS_ACCESS_KEY_ID$|AWS_SECRET_ACCESS_KEY$|AWS_SESSION_TOKEN$|SPACES_ACCESS_ID$|SPACES_SECRET_KEY$|SCRYDEX_API_KEY$|SCRYDEX_TEAM_ID$|TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE$|STRIPE_|EASYPOST_)"
Get-ChildItem Env: |
  Where-Object { $_.Name -match $localProofCredentialPattern } |
  Remove-Item
$env:REPRESENTATIVE_CATALOG_PACK_SOURCE = (Resolve-Path "artifacts/observation-packs/accepted").Path
```

`representative-catalog` is opt-in. It is allowed only in dev, local, remote-dev, test, and preview, and it is never a default data profile. A pack must have an `accepted` governance posture and must match the active Provider Integration Profile and replay contract. Verify every local pack before changing the sandbox:

```powershell
$packManifests = @(Get-ChildItem $env:REPRESENTATIVE_CATALOG_PACK_SOURCE -Recurse -Filter manifest.json)
if ($packManifests.Count -lt 1 -or $packManifests.Count -gt 4) { throw "Expected one to four accepted Observation Packs." }
foreach ($manifest in $packManifests) {
  pnpm observation-pack:verify -- --target local --pack-dir $manifest.DirectoryName --require-accepted true
  if ($LASTEXITCODE -ne 0) { throw "Observation Pack verification failed." }
}
```

The replay reader verifies every declared payload and image before writing pack state. It does not make provider network calls.

## Restore or replay the representative Catalog

Use one path, not both:

- Snapshot restore is the normal fast path when `REPRESENTATIVE_CATALOG_PACK_MANIFEST_KEYS` names the same ordered accepted pack set used to publish a compatible snapshot. It validates the immutable pack content identity, active profile versions, replay contract, migration ledger, database/object mapping, and asset inventory before any restore. A cold restore populates `artifacts/representative-snapshot-cache`; a later compatible restore revalidates and reuses it.
- Replay is the offline fallback when no compatible snapshot exists or when working only with local accepted pack directories. It runs the real import, promotion, Product Asset Set, and projection path. It is explicit; snapshot incompatibility never silently weakens into a replay.

Snapshot restore is sufficient for ordinary browsing. The closed cohort and day-after proof below must use replay because it requires the real replay append receipt from both boots.

For a compatible snapshot set:

```powershell
$env:REPRESENTATIVE_CATALOG_PACK_MANIFEST_KEYS = "<manifest-key-1>,<manifest-key-2>"
pnpm run dev:db:refresh --representative
```

For a local accepted-pack replay:

```powershell
New-Item -ItemType Directory -Force "artifacts/local-representative-data" | Out-Null
$env:REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT = (Join-Path $PWD "artifacts/local-representative-data/catalog-replay.json")
pnpm run dev:db:refresh --representative --replay
```

Both commands destroy only this worktree sandbox's Postgres volume before rebuilding it. Snapshot restore additionally uses the shipped all-or-nothing failure boundary: after preflight, any database, asset, bootstrap, or verifier failure resets the whole disposable sandbox instead of leaving a mixed snapshot set. Do not bypass compatibility checks or reuse another worktree's cache, volume, ports, asset root, credentials, or artifacts.

## Import the sandbox environment

The platform composition command runs directly from its package, so import this worktree's generated database URLs and ports into the current PowerShell session:

```powershell
pnpm run sandbox:env |
  Where-Object { $_ -match "^[A-Z0-9_]+=" } |
  ForEach-Object {
    $name, $value = $_ -split "=", 2
    Set-Item -Path "Env:$name" -Value $value
  }
$env:DATABASE_URL = $env:POSTGRES_DEV_DATABASE_URL
$env:PORT = $env:PLATFORM_API_PORT
$env:CATALOG_ASSET_PUBLIC_BASE_URL = "$($env:PLATFORM_API_URL)/catalog-assets"
$env:MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL = "$($env:PLATFORM_API_URL)/marketplace-listing-photos"
```

Do not import another lane's `.env.sandbox.local`. Platform API, worker, browser, bootstrap, `pg_dump`, and `pg_restore` children must not inherit release-evidence or seed-pack object-store credentials. The snapshot implementation supplies its scoped pair only at the object-storage boundary.

## Layer representative commerce

Representative commerce keeps the restored or replayed Catalog truth in place and adds local accounts, inventory, listings, offers, orders, payments, fulfillment, settlement, reviews, support requests, and notifications. The local allowance and confirmation phrase are intentional safety gates and remain unchanged:

```powershell
$env:REPRESENTATIVE_COMMERCE_STATE_ALLOW_LOCAL = "true"
$env:REPRESENTATIVE_COMMERCE_STATE_CONFIRM = "seed staging commerce"
$env:REPRESENTATIVE_COMMERCE_STATE_EVIDENCE_OUT = (Join-Path $PWD "artifacts/local-representative-data/commerce-state.json")
pnpm --filter @chase-sets/app-platform-api run representative-commerce-state 2>&1 |
  Tee-Object "artifacts/local-representative-data/commerce-state.log"
if ($LASTEXITCODE -ne 0) { throw "Representative commerce generation failed." }
```

Require a final `representative-commerce-state.complete` record with non-zero selected, Marketplace reconciliation, Inventory reconciliation, listing, and offer counts. The replay receipt contains only immutable pack/replay facts plus the support-safe sandbox id, Postgres port, and Catalog database name—never a database URL or credential. Neither receipt may contain user/account PII or mutable provider state. In the replay proof, the completion's `representativeCatalogReplay` identities must be present; the command reads the receipt path from `REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT` but carries only immutable SHA-256 identities into the completion.

Start the repository-supported browser system in a second terminal so the first closure can verify the real Catalog asset route. Repeat the sandbox-environment import from the prior section in that terminal, then select the representative browser profile:

```powershell
$env:PLATFORM_DATA_PROFILES = "critical-bootstrap,catalog-integration-bootstrap,representative-commerce-state"
pnpm run dev:browser-e2e
```

Leave it in the foreground. Its normal bootstrap reconciles the same profile idempotently but does not replace the standalone commerce completion. Wait for the reported platform and Marketplace URLs before continuing in the first terminal.

Then prove that the exact Catalog Items selected by that commerce completion came from the accepted pack set. The verifier derives external references from each accepted pack through the active mapping contract, joins them to Catalog external references, and closes the result over the current worktree sandbox:

```powershell
$initialClosurePath = (Join-Path $PWD "artifacts/local-representative-data/pack-cohort-initial.json")
$cohortArguments = @(
  "observation-pack:verify", "--",
  "--target", "local",
  "--pack-dir", $env:REPRESENTATIVE_CATALOG_PACK_SOURCE,
  "--commerce-cohort", "true",
  "--minimum-cohort-percentage", "90",
  "--catalog-database-url", $env:DATABASE_URL_CATALOG,
  "--discovery-database-url", $env:DATABASE_URL_DISCOVERY,
  "--marketplace-database-url", $env:DATABASE_URL_MARKETPLACE,
  "--asset-base-url", $env:CATALOG_ASSET_PUBLIC_BASE_URL,
  "--replay-receipt", $env:REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT,
  "--commerce-completion", $env:REPRESENTATIVE_COMMERCE_STATE_EVIDENCE_OUT
)
$initialCohortOutput = @(& pnpm @cohortArguments 2>&1)
$initialCohortExitCode = $LASTEXITCODE
$initialCohortOutput | Tee-Object "artifacts/local-representative-data/pack-cohort-initial.log"
if ($initialCohortExitCode -ne 0) { throw "Representative commerce pack cohort closure failed." }
$initialClosureJson = @($initialCohortOutput | Where-Object {
  $_ -match '"schemaVersion":"commerce-pack-cohort-closure\.evidence/v1"'
})
if ($initialClosureJson.Count -ne 1) { throw "Expected one closed cohort evidence record." }
$initialClosureJson[0] | Set-Content -LiteralPath $initialClosurePath
```

The support-safe result binds one `closedIdentity` across the ordered accepted pack ids, versions, relative manifest keys, and capture-content hashes; the replay state and append receipt; Catalog and Discovery equality evidence; the canonical Catalog, Discovery, and Marketplace databases for this worktree; and the commerce state identity with its exact selected Catalog Item set, digest, and count. The closed proof requires the default 50-item candidate budget and recomputes the denominator from that budget, the planned candidate count, and the required priority candidates before comparing it with the exact selected set. Every current `lst_repr_*` and `off_repr_*` projection row must reconcile to the same set and completion counts, so denominator narrowing and stale, omitted, extra, or duplicate representative rows fail closed.

## Prove the retained-state day-after boot

Repeat the shipped bootstrap and commerce compositions without refreshing or deleting the sandbox. This overwrites the replay and commerce receipts with the second boot:

```powershell
$env:PLATFORM_DATA_PROFILES = "critical-bootstrap,catalog-integration-bootstrap,representative-catalog"
pnpm run dev:bootstrap
if ($LASTEXITCODE -ne 0) { throw "Retained-state Catalog replay failed." }

pnpm --filter @chase-sets/app-platform-api run representative-commerce-state 2>&1 |
  Tee-Object "artifacts/local-representative-data/commerce-state-day-after.log"
if ($LASTEXITCODE -ne 0) { throw "Retained-state representative commerce generation failed." }
```

Run the same closure verifier against the retained first-boot evidence:

```powershell
$dayAfterArguments = $cohortArguments + @("--prior-evidence", $initialClosurePath)
$dayAfterOutput = @(& pnpm @dayAfterArguments 2>&1)
$dayAfterExitCode = $LASTEXITCODE
$dayAfterOutput | Tee-Object "artifacts/local-representative-data/pack-cohort-day-after.log"
if ($dayAfterExitCode -ne 0) { throw "Retained-state cohort closure failed." }
if (-not ($dayAfterOutput -match '"dayAfterControl":\{"status":"verified"')) {
  throw "Retained-state day-after control was not verified."
}
```

The second receipt must report zero appended Catalog events and zero appended Product Asset Sets. Its run identity must be the exact receipt identity carried by the second commerce completion, while the stable `closedIdentity`, pack set, replay state, Catalog/Discovery equality, database set, commerce state, selected digest, and denominator remain equal to the first boot. Do not edit either receipt: substitution, reordering, narrowing the pack root, or mixing another sandbox's URLs is a verifier failure.

## Browse the assembled marketplace

With the already-running browser system, open its reported `MARKETPLACE_WEB_URL`, then:

1. Open `/search`.
2. Search for a title from the accepted pack and wait for a visible `View details for …` result. Catalog pages keep an SSE connection open, so wait for visible results rather than network-idle.
3. Capture the search/results view with real card art and market availability.
4. Open the result and confirm the `/items/…` route visibly shows the title, real art, `Lowest ask`, and `Buy options`.
5. Capture the listing detail.

These two real-route screenshots and the textual command transcript belong on the PR or issue, not in a committed evidence ledger.

## Teardown and exact reset

Stop the foreground browser system with `Ctrl+C`, then remove only this worktree's containers and volumes:

```powershell
pnpm run sandbox:clean
```

Remove the two worktree-owned runtime asset roots. The containment check fails before deletion if either path escapes the current checkout:

```powershell
$worktreeRoot = [IO.Path]::GetFullPath($PWD.Path).TrimEnd("\") + "\"
$runtimeAssetRoots = @(
  "artifacts/catalog-assets/platform-api",
  "artifacts/marketplace-listing-photos/platform-api"
)
foreach ($relativePath in $runtimeAssetRoots) {
  $ownedPath = [IO.Path]::GetFullPath((Join-Path $PWD $relativePath))
  if (-not $ownedPath.StartsWith($worktreeRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a path outside this worktree: $ownedPath"
  }
  if (Test-Path -LiteralPath $ownedPath) {
    Remove-Item -LiteralPath $ownedPath -Recurse -Force
  }
}
```

Finally clear the session-only selectors and safety gates:

```powershell
@(
  "REPRESENTATIVE_CATALOG_PACK_SOURCE",
  "REPRESENTATIVE_CATALOG_PACK_MANIFEST_KEYS",
  "REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT",
  "PLATFORM_DATA_PROFILES",
  "REPRESENTATIVE_COMMERCE_STATE_ALLOW_LOCAL",
  "REPRESENTATIVE_COMMERCE_STATE_CONFIRM",
  "REPRESENTATIVE_COMMERCE_STATE_EVIDENCE_OUT"
) | ForEach-Object { Remove-Item -Path "Env:$_" -ErrorAction SilentlyContinue }
```

The accepted input packs and `artifacts/local-representative-data` evidence may be retained locally until the PR evidence is posted; neither is a running service or database. Delete them only by exact reviewed path when they are no longer needed.
