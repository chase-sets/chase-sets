# Staging Alias Import Environment

## Goal

Unblock the post-merge Platform Deploy run that superseded the catalog search card-layout delivery by allowing the staging App Platform alias DNS reconciliation step to run `terraform import` with the same required Terraform inputs used by plan/apply.

## Evidence

- Platform Deploy run `26478899146` failed in `Reconcile staging App Platform alias DNS state` before `Terraform plan`.
- The failed step called `terraform import`, and Terraform reported missing required variables such as `digitalocean_token`, `spaces_access_id`, `platform_admin_email`, and `platform_admin_password`.
- The neighboring `Terraform plan` and `Terraform apply` steps already provide the required secret-backed `TF_VAR_*` values.

## Decision

- Keep the reconciliation logic unchanged.
- Add the same Terraform input environment to the reconciliation step so Terraform can evaluate the root module during import.
- Add a workflow-config test that asserts the reconciliation step carries representative required Terraform variables.

## Verification

- `pnpm exec prettier .github/workflows/platform-production.yml scripts/digitalocean-platform-config.test.mjs --check`
- `pnpm run test:digitalocean-app-deployment`
- `pnpm run verify:static`
