output "environment_zone" {
  value = digitalocean_domain.environment.name
}

output "catalog_asset_domain" {
  value = "assets.${digitalocean_domain.environment.name}"
}

output "doks_ingress_serving_domains" {
  value = {
    for key, record in local.doks_serving_records :
    key => record.fqdn
  }
}
