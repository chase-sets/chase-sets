locals {
  project_names = {
    production = "chase-sets-production"
    staging    = "chase-sets-staging"
    preview    = "chase-sets-previews"
  }
  environment_project_id = trimspace(var.environment_project_id) != "" ? trimspace(var.environment_project_id) : data.digitalocean_project.environment[0].id
}

data "digitalocean_project" "environment" {
  count = trimspace(var.environment_project_id) == "" ? 1 : 0
  name  = local.project_names[var.environment]
}

# Direct project_id changes are replacement-only in the pinned provider.
resource "digitalocean_project_resources" "environment" {
  project = local.environment_project_id
  resources = concat(
    [digitalocean_app.platform.urn],
    [for cluster in digitalocean_database_cluster.postgres : cluster.urn],
    local.is_production ? ["do:domain:${var.root_domain}"] : [],
  )
}
