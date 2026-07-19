output "environment_zone" {
  value = local.environment_zone
}

output "catalog_asset_domain" {
  value = local.is_staging ? "assets.${local.environment_zone}" : null
}

output "doks_ingress_diagnostic_domains" {
  value = {
    for key, record in local.doks_diagnostic_records :
    key => record.fqdn
  }
}
