output "environment_zone" {
  value = digitalocean_domain.environment.name
}

output "catalog_asset_domain" {
  value = "assets.${digitalocean_domain.environment.name}"
}

output "staging_app_serving" {
  value = var.staging_app_serving
}

output "doks_ingress_shadow_domains" {
  value = {
    for key, record in local.doks_shadow_records :
    key => record.fqdn
  }
}
