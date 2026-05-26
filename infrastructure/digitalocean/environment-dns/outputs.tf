output "environment_zone" {
  value = digitalocean_domain.environment.name
}

output "catalog_asset_domain" {
  value = "assets.${digitalocean_domain.environment.name}"
}
