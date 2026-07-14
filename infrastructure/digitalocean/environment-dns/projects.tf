locals {
  project_names = {
    staging = "chase-sets-staging"
  }
  environment_project_id = trimspace(var.environment_project_id) != "" ? trimspace(var.environment_project_id) : data.digitalocean_project.environment[0].id
}

data "digitalocean_project" "environment" {
  count = trimspace(var.environment_project_id) == "" ? 1 : 0
  name  = local.project_names[var.environment]
}

resource "digitalocean_project_resources" "environment" {
  project   = local.environment_project_id
  resources = [digitalocean_domain.environment.urn]
}
