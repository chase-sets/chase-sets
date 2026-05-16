locals {
  bucket_names = {
    preview    = "chase-sets-preview-catalog-assets"
    staging    = "chase-sets-staging-catalog-assets"
    production = "chase-sets-production-catalog-assets"
  }

  custom_domains = {
    preview    = "assets.preview.${var.root_domain}"
    staging    = "assets.staging.${var.root_domain}"
    production = "assets.${var.root_domain}"
  }

  bucket_name        = local.bucket_names[var.environment]
  custom_domain      = local.custom_domains[var.environment]
  bucket_origin      = "${local.bucket_name}.${var.region}.digitaloceanspaces.com"
  certificate_name   = "chase-sets-${var.environment}-catalog-assets-cdn"
  preview_expiration = var.environment == "preview" ? [1] : []
}
