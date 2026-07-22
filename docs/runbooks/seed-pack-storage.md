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

The provider constraint is `digitalocean/digitalocean ~> 2.85`; `hashicorp/setup-terraform` is SHA-pinned in the workflow. Review both before an operator window. Never print a secret output or attach Terraform state to an issue or PR.

## Apply Window

Use an owner-attended window with no concurrent seed-pack Terraform run. For the first apply, schedule the operator session immediately after this repository change merges and before the next daily `Platform Terraform State Snapshot` run at 09:23 UTC; the durable-state inventory includes `seed-packs/shared.tfstate` once the repository change lands. Prefer the `Platform Seed Packs Apply` workflow: run `mode=plan` at the exact intended commit, review the artifact for exactly three creates (the private versioned bucket and two bucket-scoped `readwrite` keys), then run `mode=apply` with confirmation `apply seed-packs`. The apply job repeats that exact plan and runs both access probes before it succeeds.

For a local operator session from `infrastructure/digitalocean/seed-packs`:

```sh
cp backend.hcl.example backend.hcl
terraform init -reconfigure -backend-config=backend.hcl
terraform plan -out=tfplan
terraform show -no-color tfplan
terraform apply tfplan
```

Expected first apply: `3 to add, 0 to change, 0 to destroy`. Stop on any other resource count, any public ACL, a grant whose bucket is not `cs-dev-seed-packs`, or any current-object age expiration.

## Provider Acceptance and Access Probes

After apply, create a disposable object with each scoped key. For each key, request that exact object without authentication and require HTTP `403` with `AccessDenied`. Then use the scoped key against `chase-sets-terraform-state` and require an `AccessDenied` response. Delete the disposable object before ending the window. The apply workflow performs this sequence for both keys without printing their values.

These live probes remain operator evidence. Terraform validation, provider-schema inspection, and a `-refresh=false` fixture plan do not prove DigitalOcean accepted the bucket, lifecycle, or grant contract.

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

Post on #5874: exact commit and workflow run, redacted plan summary, provider version, bucket/versioning/lifecycle outputs, both unauthenticated `403` results, both cross-bucket `AccessDenied` results, destination names updated (never values), rollback status, and current Space usage against the 5 GiB bound.
