output "bucket_name" {
  value = digitalocean_spaces_bucket.catalog_assets.name
}

output "bucket_origin" {
  value = local.bucket_origin
}

output "cdn_endpoint" {
  value = digitalocean_cdn.catalog_assets.endpoint
}

output "public_base_url" {
  value = "https://${local.custom_domain}"
}

output "custom_domain" {
  value = local.custom_domain
}
