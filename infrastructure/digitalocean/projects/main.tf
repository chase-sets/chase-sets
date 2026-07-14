resource "digitalocean_project" "production" {
  name        = "chase-sets-production"
  description = "Production resources for Chase Sets."
  purpose     = "Web Application"
  environment = "Production"
  is_default  = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_project" "staging" {
  name        = "chase-sets-staging"
  description = "Staging resources for Chase Sets."
  purpose     = "Web Application"
  environment = "Staging"
  is_default  = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_project" "previews" {
  name        = "chase-sets-previews"
  description = "Ephemeral previews and default-routed development resources for Chase Sets."
  purpose     = "Web Application"
  environment = "Development"
  is_default  = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_project" "ops" {
  name        = "chase-sets-ops"
  description = "Shared operational resources for Chase Sets."
  purpose     = "Operational Infrastructure"
  is_default  = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_project_resources" "terraform_state" {
  project   = digitalocean_project.ops.id
  resources = [local.terraform_state_space_urn]

  lifecycle {
    prevent_destroy = true
  }
}
