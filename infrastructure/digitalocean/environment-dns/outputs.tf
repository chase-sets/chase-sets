output "environment_zone" {
  value = local.environment_zone
}

output "catalog_asset_domain" {
  value = local.is_staging ? "assets.${local.environment_zone}" : null
}

output "staging_app_serving" {
  value = var.staging_app_serving
}

output "production_app_serving" {
  value = var.production_app_serving
}

output "app_serving" {
  value = local.app_serving
}

output "doks_ingress_shadow_domains" {
  value = {
    for key, record in local.doks_shadow_records :
    key => record.fqdn
  }
}
