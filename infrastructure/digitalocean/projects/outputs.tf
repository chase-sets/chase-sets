output "project_ids" {
  description = "DigitalOcean project IDs keyed by the canonical Chase Sets environment or operational scope."
  value = {
    production = digitalocean_project.production.id
    staging    = digitalocean_project.staging.id
    preview    = digitalocean_project.previews.id
    ops        = digitalocean_project.ops.id
  }
}

output "project_names" {
  description = "DigitalOcean project names keyed by the canonical Chase Sets environment or operational scope."
  value = {
    production = digitalocean_project.production.name
    staging    = digitalocean_project.staging.name
    preview    = digitalocean_project.previews.name
    ops        = digitalocean_project.ops.name
  }
}

output "terraform_state_space_urn" {
  description = "URN assigned to the operations project for Terraform backend state."
  value       = local.terraform_state_space_urn
}
