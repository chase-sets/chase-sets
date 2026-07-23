# Seed Pack Storage

Use this runbook for the shared non-production Observation Pack Space approved in #5872. Terraform source is in [`infrastructure/digitalocean/seed-packs`](../../infrastructure/digitalocean/seed-packs). The Space is private, versioned, capped operationally at 5 GiB, and has no CDN.

## Credential Inventory

| Purpose | Names | Scope |
| --- | --- | --- |
| Terraform state backend | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Read/write and lock `seed-packs/shared.tfstate` in `chase-sets-terraform-state` |
| DigitalOcean provider | `TF_VAR_digitalocean_token` | Manage the Space and scoped-key resources through the DigitalOcean API |
| Terraform Spaces provider | `TF_VAR_spaces_access_id`, `TF_VAR_spaces_secret_key` | Create/update the Space through the Spaces API |
| Dev pack access | Terraform outputs `dev_spaces_access_id`, `dev_spaces_secret_key` | Read/write `cs-dev-seed-packs` only |
| CI/preview pack access | Terraform outputs `ci_spaces_access_id`, `ci_spaces_secret_key` | Read/write `cs-dev-seed-packs` only |

## Observation Pack Capture and Acceptance

Repository tooling does not use DigitalOcean API or Terraform credentials. TCGdex, Scryfall, and LorcanaJSON are public-provider captures. The Scrydex capture additionally requires the shared `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID`. Space writes and reads require the bucket-scoped `SEED_PACKS_SPACES_ACCESS_ID` and `SEED_PACKS_SPACES_SECRET_KEY`; they are not interchangeable with `DIGITALOCEAN_ACCESS_TOKEN`, `SPACES_ACCESS_ID`, or `SPACES_SECRET_KEY`.

Until Todd-only #5951 completes the real apply, provider probes, and scoped-key provisioning, run local captures only. Packs belong under gitignored `artifacts/` and must never be added to git:

```sh
pnpm observation-pack:capture -- capture --preset pokemon-prismatic-evolutions --target local --output-dir artifacts/observation-packs
pnpm observation-pack:capture -- capture --preset mtg-time-spiral --target local --output-dir artifacts/observation-packs
pnpm observation-pack:capture -- capture --preset one-piece-romance-dawn --target local --output-dir artifacts/observation-packs
pnpm observation-pack:capture -- capture --preset lorcana-the-first-chapter --target local --output-dir artifacts/observation-packs
```

After #5951 provisions the scoped keys, repeat the four commands with `--target space` and omit `--output-dir`. Each command invokes the configured executable `ProviderAdapter`, sanitizes its returned transport envelopes, strips pricing and market fields, uploads immutable chunks/assets before the manifest, and performs exact read-back and hash verification. Record each support-safe JSON result and its `manifestKey`; do not attach manifests, envelopes, images, provider responses, or credentials to GitHub.

Verify each captured Space pack independently:

```sh
pnpm observation-pack:verify -- --target space --manifest-key '<manifestKey>' --require-accepted false
```

Todd reviews the four count summaries, zero privacy/pricing diagnostics, and a bounded local inspection of representative downloaded images. Todd then records acceptance without changing captured payload or asset content:

```sh
pnpm observation-pack:capture -- accept --target space --manifest-key '<manifestKey>' --accepted-by Todd --decision-link https://github.com/chase-sets/chase-sets/issues/5872
pnpm observation-pack:verify -- --target space --manifest-key '<manifestKey>' --require-accepted true
```

Run both commands for all four manifest keys. A captured pack is valid retained evidence but is not replay-eligible. Only the accepted posture is replay-eligible. If any command reports `blocked`, use only its bounded diagnostic codes for support and keep provider bodies, exception text, URLs, manifests, and customer/provider data out of logs and issues.

## Accepted Pack Replay

`representative-catalog` is an explicit seed profile; it is not included in any default profile list. Set `REPRESENTATIVE_CATALOG_PACK_SOURCE` to one of these bounded read-only sources:

- a local directory containing one to four complete accepted pack directories; or
- a comma- or newline-separated list of one to four HTTPS `manifest.json` object URLs from the private Space or an operator-created read-only cache.

The replay reader refuses redirects, non-HTTPS remote sources, symbolic links, paths outside the local root, more than four manifests, contract/version mismatches, and responses beyond the contract-derived object limits. It actively times out downloads and consumes every response body within its cap. Never put a source URL, signed query string, provider response, or exception body in logs or issue evidence.

Run an explicit local or preview replay with the normal seed host and only the intended profile:

```sh
REPRESENTATIVE_CATALOG_PACK_SOURCE='<bounded-local-directory-or-https-manifest-list>' \
PLATFORM_DATA_PROFILES=representative-catalog \
pnpm --filter @chase-sets/app-platform-api run bootstrap
```

Replay preflights every declared asset for presence, exact byte count and hash, and full image decoding before it writes any state for that pack. It then uses the active profile-driven import planner, executable mapper, Source Observation recorder, duplicate-prevention and promotion planners, and Product Asset Set normalization/storage. A second boot must report `appendedEventCount: 0`; existing content-addressed source hashes are not written again.

After replay and projection drain, verify each pack against the Catalog and Discovery databases and the running local asset route:

```sh
pnpm observation-pack:verify -- \
  --target local \
  --pack-dir '<one-pack-directory>' \
  --require-accepted true \
  --post-replay true \
  --catalog-database-url '<bounded-catalog-database-url>' \
  --discovery-database-url '<bounded-discovery-database-url>' \
  --asset-base-url 'http://127.0.0.1:<port>/catalog-assets'
```

The post-replay result includes an equality digest over the external-reference digest, fan-out-aware envelope/observation/Catalog Item/Product Asset Set/Discovery counts, and per-table row counts for Catalog and Discovery read models. It also completes an HTTP 200/body check for every stored source and variant URL. The verifier accepts only a localhost `/catalog-assets` base.

## Representative Snapshot Sets

The snapshot accelerator stores one coordinated set, never a partial database snapshot: one custom-format `pg_dump` for the control database and every bounded-context database discovered by the canonical worktree sandbox inventory, plus one Catalog asset bundle and a closed manifest containing every byte count and SHA-256 digest. Do not hand-maintain a database list in a workflow or runbook.

Snapshot compatibility binds four independently named components:

1. ordered accepted Observation Pack ids, versions, manifest keys, and capture-content hashes;
2. ordered active Provider Integration Profile keys and versions;
3. the Observation Pack replay contract version; and
4. the ordered migration-ledger hash across every snapshotted database.

The publish lifecycle is `replaying -> published` (steady) and then `superseded -> deleted`. Publishing a new set moves the prior published index entry to `superseded`; deletion remains a Todd-only bounded object-prefix operation. The restore lifecycle is `compatible -> restoring -> restored`. A failure after restore starts instead runs `resetting -> reset`; if that bounded cleanup itself fails, the terminal state is truthfully `reset-failed`. The reset destroys only the current worktree's disposable Postgres volume and removes only its artifact-scoped Catalog asset root, so a failed database N cannot leave a mixed old/new coordinated set.

Before mutation, the index's manifest SHA-256 must match the exact manifest bytes. The manifest then cross-binds the full compatibility record, ordered verifier packs, canonical ordered database-to-object mapping, asset bundle, and ordered per-file asset inventory into one recomputable snapshot identity. Reordered, substituted, omitted, extra, corrupt, or stale state refuses before any `pg_restore` or asset replacement. Pack-version, pack-content, profile-version, replay-contract, and migration-ledger mismatches each have a distinct diagnostic. A dump, bundle, or per-asset digest mismatch is also a hard refusal.

Configure the same ordered accepted manifest keys used for replay:

```sh
REPRESENTATIVE_CATALOG_PACK_MANIFEST_KEYS='<manifest-key-1>,<manifest-key-2>,<manifest-key-3>,<manifest-key-4>' \
pnpm run dev:db:refresh --representative
```

The first compatible restore downloads the immutable set into `artifacts/representative-snapshot-cache`; later restores validate and reuse that cache. `pg_dump`, `pg_restore`, replay, and bootstrap children start from a minimal execution environment: ambient libpq/database selectors and unrelated Space credentials are absent, while canonical local sandbox database URLs are added only by the sandbox bootstrap. After restoring all dumps and assets, the command runs the normal bootstrap with only `critical-bootstrap`, `catalog-integration-bootstrap`, and `representative-catalog`, then recomputes the post-replay verifier digest and requires exact equality with the publish manifest.

When no compatible snapshot exists, full local replay is the routine fallback, not an override of compatibility:

```sh
REPRESENTATIVE_CATALOG_PACK_SOURCE='<bounded-local-pack-directory>' \
pnpm run dev:db:refresh --representative --replay
```

Publishing is never automatic. Todd manually dispatches `Representative Catalog Snapshot`, supplies the ordered accepted manifest keys and exact confirmation `publish representative snapshot`, and reviews the support-safe report. The one provider-touching step receives only `SEED_PACKS_SPACES_ACCESS_ID` and `SEED_PACKS_SPACES_SECRET_KEY` at step scope. Platform API, worker, and bootstrap children receive no `RELEASE_EVIDENCE_SPACES_*` or snapshot Space credential; the snapshot command receives only its scoped pair and storage configuration at the object-storage boundary.

The terminal proving session is Todd-only: first prove the scoped CI secret names exist (never values), manually publish, clear the local snapshot cache, restore once cold, restore once warm, and record both publish/restore verifier digests plus the warm timing and machine. The warm target is under two minutes and is recorded evidence, not a CI timeout. Repository tests use local file storage, fake commands, and synthetic payloads only; they do not dispatch the workflow or read/write a real Space.

The provider constraint is `digitalocean/digitalocean ~> 2.85`; `hashicorp/setup-terraform` is SHA-pinned in the workflow. Review both before an operator window. Never print a secret output or attach Terraform state to an issue or PR.

## Apply Window

Use an owner-attended window with no concurrent seed-pack Terraform run. For the first apply, schedule the operator session immediately after this repository change merges and before the next daily `Platform Terraform State Snapshot` run at 09:23 UTC; the durable-state inventory includes `seed-packs/shared.tfstate` once the repository change lands.

The `Platform Seed Packs Apply` workflow has two disjoint operations:

1. On `main`, copy the exact current 40-character lowercase commit SHA. Dispatch `mode=plan` with that SHA as `release_ref` and confirmation `plan seed-packs`. The workflow rejects mutable refs and refuses to plan unless its own `main` workflow commit is that exact SHA.
2. Download `seed-packs-reviewed-plan-<run-id>-<run-attempt>`. Review `reviewed-plan.txt` for exactly three creates (the private versioned bucket and two bucket-scoped `readwrite` keys), no other changes, no public ACL, and no unexpected lifecycle rule. Cross-check `provenance.json` and the job summary: repository, workflow path/ref, source run/attempt, release commit/ref, `production` approval environment, Terraform root, state key, Terraform version, and configuration/lock/backend/review/apply-payload digests must all be present. Record the source run ID, run attempt, and the `sha256:` GitHub artifact digest from the summary.
3. Within 24 hours, dispatch `mode=apply` with the same exact `release_ref`, the recorded reviewed run ID, run attempt, artifact digest, and confirmation `apply seed-packs`. Approve the `production` job only when those inputs name the artifact just reviewed. Missing inputs, mutable or mismatched commits, another repository/workflow/branch, a failed or non-dispatch source run, another attempt, an expired or stale artifact, and any artifact/provenance/configuration digest mismatch all fail before Terraform can apply.

The apply operation downloads only that named artifact from this repository and source run. It authenticates and decrypts the saved binary payload, initializes the backend, and executes `terraform apply` against that file. It never runs `terraform plan`. A changed Terraform state makes Terraform reject the saved plan as stale; provider observations that changed after planning cannot be folded into a fresh unreviewed plan. Stop and create a new plan run instead of bypassing either failure.

For repository-only validation from `infrastructure/digitalocean/seed-packs`, keep the backend disabled and providers mocked:

```sh
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
terraform test
```

Do not perform a local provider plan/apply for this change. Todd-only operator issue #5951 owns the terminal workflow plan review, production approval, apply, live probes, and scoped-key provisioning. Expected first apply remains `3 to add, 0 to change, 0 to destroy`. Stop on any other resource count, any public ACL, a grant whose bucket is not `cs-dev-seed-packs`, or any current-object age expiration.

## Reviewed Plan Protection

Terraform binary plans can contain cleartext sensitive values. The plan operation therefore deletes the plaintext binary before artifact upload and retains only secret-safe `reviewed-plan.txt`, authenticated `provenance.json`, and `apply-payload.enc`. The payload uses AES-256-GCM with an HKDF-derived key rooted in the already-authorized `SPACES_SECRET_KEY`; no new secret or operator provisioning step is required. The encryption material is step-local and never printed. Exact credential values are checked against the review text before upload.

GitHub's immutable artifact digest binds the three uploaded files. The provenance bytes are authenticated as encryption associated data, and the decrypted payload digest must match the reviewed provenance before the temporary binary is written. The apply step deletes that temporary file on success or failure. Tampering, a wrong authorized secret, a substituted bundle or payload, or decryption failure stops before provider mutation.

## Provider Acceptance and Access Probes

After apply, create a disposable object with each scoped key. For each key, request that exact object without authentication and require HTTP `403` with `AccessDenied`. Then use the scoped key against `chase-sets-terraform-state` and require an `AccessDenied` response. Delete the disposable object before ending the window. The apply workflow performs this sequence for both keys without printing their values.

These live probes remain operator evidence queued in #5951. Terraform validation, provider-schema inspection, and a backend-disabled mocked plan do not prove DigitalOcean accepted the bucket, lifecycle, or grant contract; do not claim provider acceptance until #5951 records the real responses.

## Secret Handoff

Read sensitive outputs only into the destination secret manager. Store the dev pair under `SEED_PACKS_SPACES_ACCESS_ID` and `SEED_PACKS_SPACES_SECRET_KEY` for Todd-controlled local/remote-dev use. Store the CI pair under the same names in the GitHub `preview` and `merge-gate` environments. Do not add them to `staging` or `production`; `representative-catalog` is prohibited there.

## Rotate a Scoped Key

Rotate one audience at a time. Apply `terraform apply -replace=digitalocean_spaces_key.dev` or `terraform apply -replace=digitalocean_spaces_key.ci`, capture the new sensitive outputs directly into the relevant destinations, prove seed-bucket read/write plus cross-bucket denial, then remove the old value from every destination. A replacement revokes the Terraform-managed old key; if the apply fails after provider mutation, stop and reconcile the DigitalOcean key inventory with state before retrying.

## Delete Revoked or Superseded Packs

After the pack manifest records `revoked` or `superseded`, delete every object under that immutable pack-version prefix using one scoped key:

```sh
aws s3api list-objects-v2 --bucket cs-dev-seed-packs --prefix '<pack-version-prefix>/' --endpoint-url https://nyc3.digitaloceanspaces.com
aws s3api delete-objects --bucket cs-dev-seed-packs --delete file://delete-request.json --endpoint-url https://nyc3.digitaloceanspaces.com
aws s3api list-object-versions --bucket cs-dev-seed-packs --prefix '<pack-version-prefix>/' --endpoint-url https://nyc3.digitaloceanspaces.com
```

Build `delete-request.json` from the reviewed exact key list, never from an unbounded bucket listing. Record the lifecycle transition time and deletion command result on the governing issue. The delete markers make payload versions noncurrent; the bucket lifecycle permanently expires those versions within 30 days. Re-run `list-object-versions` after the deadline and escalate if any payload version remains.

## Rollback and Evidence

Before apply, rollback is no-op. After bucket creation, keep the private bucket and revoke either scoped key with `terraform destroy -target=digitalocean_spaces_key.<dev|ci>` only when access must end immediately; remove its destination secrets in the same window. Do not destroy the bucket or bypass `prevent_destroy`. For an erroneous grant, revoke the affected key first, correct source, and apply a replacement.

Post the terminal operator evidence on #5951 and cross-link it from #5874: exact commit, reviewed plan run/attempt/artifact digest, apply run, redacted plan summary, provider version, bucket/versioning/lifecycle outputs, both unauthenticated `403` results, both cross-bucket `AccessDenied` results, destination names updated (never values), rollback status, and current Space usage against the 5 GiB bound.
