# Release Qualification Evidence Terraform

This remote-state root owns exactly one resource: the private, versioned `chase-sets-release-qualification` Space that stores durable merge-queue qualification records (`release-qualification/v1`). The Space is the promotion authority for prequalified releases — a GitHub Deployment or check summary may index it but can never replace it.

Record read/write/verify behavior lives in [scripts/release-qualification-record.mjs](../../../scripts/release-qualification-record.mjs); operator procedures live in the [Release Qualification Evidence runbook](../../../docs/runbooks/release-qualification-evidence.md).

## Boundaries

- The intentionally local-state [state-bootstrap](../state-bootstrap) root is the pattern reference for versioned evidence buckets. It is not extended by this root and must remain unchanged.
- The Terraform-state bucket (`chase-sets-terraform-state`) stores this root's state at the dedicated key below; qualification records themselves never live in the state bucket.
- Runtime record access uses only the dedicated bucket-scoped Spaces key (`RELEASE_EVIDENCE_SPACES_ACCESS_ID` / `RELEASE_EVIDENCE_SPACES_SECRET_KEY` in the `merge-gate` and `production` GitHub environments). The broad Terraform automation Spaces credentials are used only to apply this root.

## Backend

State lives in the existing Terraform-state Space at the dedicated key `release-qualification/shared.tfstate`:

```sh
cp backend.hcl.example backend.hcl
terraform init -backend-config=backend.hcl
```

`backend.hcl` carries no credentials; supply `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (Terraform automation Spaces key) in the environment for init/plan/apply, plus `TF_VAR_digitalocean_token`, `TF_VAR_spaces_access_id`, and `TF_VAR_spaces_secret_key`.

## Credential-Free Validation

```sh
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

## Cost Wager (epic #5496, ratified 2026-07-21)

- One bucket on the existing Spaces subscription; this root may never create a second subscription or any other resource.
- Records are capped at 64 KiB each (enforced by the writer); the first 30 days are capped at 1 GiB total usage and $1/month projected incremental cost.
- Lifecycle rules retain current and non-current versions for 400 days, then expire them so evidence storage does not grow unbounded.
- Crossing a cap keeps downstream enforcement disabled/advisory and opens a cost-decision issue.

## Destroy Protection

The bucket uses `prevent_destroy` and `force_destroy = false`. Versioning protects against accidental overwrite or delete; it is not object lock and does not defend against a DigitalOcean account administrator. Recovery of a deleted current version is documented in the runbook.
