# DigitalOcean Projects Foundation

This account-scoped Terraform root owns the Chase Sets project taxonomy. Apply it once after [state-bootstrap](../state-bootstrap/README.md), then re-apply only when the taxonomy or shared operational placement changes.

It creates:

- `chase-sets-production` for production resources.
- `chase-sets-staging` for staging resources.
- `chase-sets-previews` for previews and other development resources. This is the account default.
- `chase-sets-ops` for shared operational resources.

The `chase-sets-terraform-state` Space is assigned to `chase-sets-ops`. Making previews the default is deliberate: resources created without explicit project placement land in a visible, non-production project instead of beside production resources.

## Boundaries

DigitalOcean projects are organizational metadata. They improve control-panel blast radius, default-project hygiene, and placement checks, but they do not split billing or create an access-control boundary within a DigitalOcean team. Separate teams are required for that level of isolation.

DigitalOcean Container Registry and VPC resources are account-scoped and cannot be assigned to projects. Naming and tags remain the cost-attribution mechanism for all resources, including those account-scoped resources.

Resource assignment belongs in the Terraform root that owns the resource. Do not centralize environment resource URNs in this root: doing so would couple independently applied states and race ephemeral preview creation and cleanup.

## State and offline validation

The remote state key is `projects/account.tfstate` in the existing `chase-sets-terraform-state` Space.

These commands install providers and validate configuration without contacting the remote backend or changing DigitalOcean resources:

```bash
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

Do not run `terraform plan` with an account token merely to validate this root. A refresh-capable plan reads live account state; use it only as part of the reviewed operator procedure below.

## One-time operator apply

Use the same operator-owned credential flow as the state bootstrap. The Spaces access key and secret are backend credentials; the DigitalOcean token is a sensitive Terraform input.

```bash
cp backend.hcl.example backend.hcl
export AWS_ACCESS_KEY_ID="$SPACES_ACCESS_ID"
export AWS_SECRET_ACCESS_KEY="$SPACES_SECRET_KEY"
terraform init -backend-config=backend.hcl
terraform plan \
  -var=digitalocean_token="$DIGITALOCEAN_ACCESS_TOKEN" \
  -out=projects.tfplan
terraform apply projects.tfplan
```

Before applying, review the saved plan for exactly four project creates and one assignment of `do:space:chase-sets-terraform-state` to the operations project. The apply deliberately changes the account default to `chase-sets-previews`. If any named project already exists, import it into the matching Terraform address before applying rather than attempting to recreate it.

After applying, verify `doctl projects list` reports previews as the default and inspect the operations project resources for the Terraform-state Space. A second plan should be empty. Retiring the previous default project is a later operation after every resource has an explicit home.

## Consumption by resource-owning roots

Other roots discover projects by name and do not read this root's remote state:

```hcl
locals {
  project_names = {
    production = "chase-sets-production"
    staging    = "chase-sets-staging"
    preview    = "chase-sets-previews"
  }
}

data "digitalocean_project" "environment" {
  name = local.project_names[var.environment]
}
```

Use `data.digitalocean_project.environment.id` for resources that accept `project_id`. For other assignable resource types, declare `digitalocean_project_resources` beside the owned resource and pass its URN. The outputs in this root are for operator inspection and module composition only; they are not a cross-state contract.
