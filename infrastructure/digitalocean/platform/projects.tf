locals {
  environment_project_id = trimspace(var.environment_project_id)
}

moved {
  from = digitalocean_project_resources.environment
  to   = digitalocean_project_resources.environment[0]
}

# Direct project_id changes are replacement-only in the pinned provider.
resource "digitalocean_project_resources" "environment" {
  count   = local.environment_project_id != "" ? 1 : 0
  project = local.environment_project_id
  resources = concat(
    [for cluster in digitalocean_database_cluster.postgres : cluster.urn],
    local.is_production ? ["do:domain:${var.root_domain}"] : [],
  )
}
