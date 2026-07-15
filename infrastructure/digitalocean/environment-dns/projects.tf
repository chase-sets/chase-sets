locals {
  environment_project_id = trimspace(var.environment_project_id)
}

moved {
  from = digitalocean_project_resources.environment
  to   = digitalocean_project_resources.environment[0]
}

resource "digitalocean_project_resources" "environment" {
  count = local.environment_project_id != "" ? 1 : 0

  project   = local.environment_project_id
  resources = [digitalocean_domain.environment.urn]
}
