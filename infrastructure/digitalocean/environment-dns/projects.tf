locals {
  project_names = {
    staging = "chase-sets-staging"
  }
}

data "digitalocean_project" "environment" {
  name = local.project_names[var.environment]
}

resource "digitalocean_project_resources" "environment" {
  project   = data.digitalocean_project.environment.id
  resources = [digitalocean_domain.environment.urn]
}
