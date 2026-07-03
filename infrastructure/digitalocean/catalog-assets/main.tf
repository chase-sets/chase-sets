resource "digitalocean_spaces_bucket" "catalog_assets" {
  name          = local.bucket_name
  region        = var.region
  acl           = "private"
  force_destroy = var.environment != "production"

  lifecycle {
    prevent_destroy = true
  }

  dynamic "lifecycle_rule" {
    for_each = local.preview_expiration
    content {
      id      = "expire-preview-catalog-assets"
      enabled = true

      expiration {
        days = 90
      }

      abort_incomplete_multipart_upload_days = 7
    }
  }
}

resource "digitalocean_certificate" "catalog_assets_cdn" {
  name    = local.certificate_name
  type    = "lets_encrypt"
  domains = [local.custom_domain]
}

resource "digitalocean_cdn" "catalog_assets" {
  origin           = local.bucket_origin
  ttl              = var.cdn_ttl_seconds
  custom_domain    = local.custom_domain
  certificate_name = digitalocean_certificate.catalog_assets_cdn.name

  depends_on = [
    digitalocean_spaces_bucket.catalog_assets,
  ]
}
