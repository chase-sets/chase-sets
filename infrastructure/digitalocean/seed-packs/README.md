# Seed Pack Terraform

This remote-state root owns the private, versioned `cs-dev-seed-packs` Space and its two bucket-scoped read/write keys: one for dev operator sessions and one for CI/preview runtime use. The Space stores governed Observation Packs and derived seed snapshots approved in #5872. It has no CDN or public access path.

Operational apply, key handoff, privacy and isolation probes, rotation, and deletion-on-revocation procedures live in the [Seed Pack Storage runbook](../../../docs/runbooks/seed-pack-storage.md).

## Backend

State lives in the existing Terraform-state Space at `seed-packs/shared.tfstate`:

```sh
cp backend.hcl.example backend.hcl
terraform init -backend-config=backend.hcl
```

Supply `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for the state backend and `TF_VAR_digitalocean_token`, `TF_VAR_spaces_access_id`, and `TF_VAR_spaces_secret_key` for the DigitalOcean provider. These broad Terraform credentials are never pack runtime credentials.

## Credential-Free Validation

```sh
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
terraform test
```

The Terraform test executes a deterministic plan against the installed DigitalOcean provider schema with the provider mocked. It neither reads state nor calls DigitalOcean. It is not evidence that DigitalOcean accepted the configuration; the operator apply and access probes provide that evidence.

## Retention and Destruction

Accepted packs have no age-based expiration. Deleting a revoked or superseded object creates a delete marker; the lifecycle rule expires its noncurrent payload versions after 30 days and removes expired delete markers. The operator must initiate deletion as described in the runbook. The bucket uses `prevent_destroy` and `force_destroy = false`.
