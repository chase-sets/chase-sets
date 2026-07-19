output "postgres_cluster_id" {
  value = try(digitalocean_database_cluster.postgres[0].id, null)
}

output "database_users" {
  value     = { for key, user in digitalocean_database_user.contexts : key => user.name }
  sensitive = true
}

output "public_domains" {
  value = local.public_domains
}

output "landing_domain" {
  value = local.landing_domain
}

output "marketplace_domains" {
  value = local.marketplace_domains
}

output "staging_root_marketplace_domains" {
  value = local.staging_root_marketplace_domains
}

output "catalog_asset_public_base_url" {
  value = local.catalog_asset_public_base_url
}

output "catalog_asset_s3_bucket" {
  value = local.catalog_asset_s3_bucket
}

output "catalog_asset_s3_endpoint" {
  value = local.catalog_asset_s3_endpoint
}

output "catalog_asset_s3_region" {
  value = var.data_region
}

output "admin_domain" {
  value = local.admin_domain
}

output "uptime_check_targets" {
  value = local.uptime_check_targets
}

output "production_database_standby_posture" {
  value = local.production_database_standby_posture
}

output "managed_postgres_alert_policies" {
  value = local.managed_postgres_alert_policies
}
