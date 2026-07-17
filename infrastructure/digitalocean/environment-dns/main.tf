moved {
  from = digitalocean_domain.environment
  to   = digitalocean_domain.environment[0]
}

moved {
  from = digitalocean_record.google_workspace_spf
  to   = digitalocean_record.google_workspace_spf[0]
}

moved {
  from = digitalocean_record.dmarc
  to   = digitalocean_record.dmarc[0]
}

moved {
  from = digitalocean_record.ses_bounce_mx
  to   = digitalocean_record.ses_bounce_mx[0]
}

moved {
  from = digitalocean_record.ses_bounce_spf
  to   = digitalocean_record.ses_bounce_spf[0]
}

moved {
  from = digitalocean_record.catalog_assets
  to   = digitalocean_record.catalog_assets[0]
}

resource "digitalocean_domain" "environment" {
  count = local.is_staging ? 1 : 0

  name = local.environment_zone

  lifecycle {
    prevent_destroy = true
  }
}

check "doks_ingress_serving_target" {
  assert {
    condition     = local.app_serving != "doks" || local.doks_ingress_target_configured
    error_message = "doks_ingress_target must be set to the environment's DOKS ingress load balancer IPv4 address before app serving flips to \"doks\"."
  }
}

check "production_doks_certificate_preflight" {
  assert {
    condition     = !local.is_production || var.production_app_serving != "doks" || var.production_doks_certificate_ready
    error_message = "production_doks_certificate_ready must be true after the live-and-shadow Certificate is Ready before production_app_serving flips to \"doks\"."
  }
}

resource "digitalocean_record" "delegation" {
  for_each = local.is_staging ? toset(local.nameservers) : toset([])

  domain = var.root_domain
  type   = "NS"
  name   = var.environment
  value  = each.value
  ttl    = 1800
}

resource "digitalocean_record" "google_workspace_mx" {
  for_each = local.is_staging ? local.google_workspace_mx_records : {}

  domain   = digitalocean_domain.environment[0].name
  type     = "MX"
  name     = "@"
  value    = each.value.value
  priority = each.value.priority
  ttl      = 14400
}

resource "digitalocean_record" "google_workspace_spf" {
  count = local.is_staging ? 1 : 0

  domain = digitalocean_domain.environment[0].name
  type   = "TXT"
  name   = "@"
  value  = "v=spf1 include:_spf.google.com ~all"
  ttl    = 14400
}

resource "digitalocean_record" "google_workspace_dkim" {
  count = local.is_staging && var.google_workspace_dkim_txt_value != "" ? 1 : 0

  domain = digitalocean_domain.environment[0].name
  type   = "TXT"
  name   = "google._domainkey"
  value  = var.google_workspace_dkim_txt_value
  ttl    = 14400
}

resource "digitalocean_record" "dmarc" {
  count = local.is_staging ? 1 : 0

  domain = digitalocean_domain.environment[0].name
  type   = "TXT"
  name   = "_dmarc"
  value  = "v=DMARC1; p=none;"
  ttl    = 1800
}

resource "digitalocean_record" "ses_bounce_mx" {
  count = local.is_staging ? 1 : 0

  domain   = digitalocean_domain.environment[0].name
  type     = "MX"
  name     = "bounce"
  value    = "feedback-smtp.us-east-2.amazonses.com."
  priority = 10
  ttl      = 1800
}

resource "digitalocean_record" "ses_bounce_spf" {
  count = local.is_staging ? 1 : 0

  domain = digitalocean_domain.environment[0].name
  type   = "TXT"
  name   = "bounce"
  value  = "v=spf1 include:amazonses.com ~all"
  ttl    = 1800
}

resource "digitalocean_record" "ses_dkim" {
  for_each = local.is_staging ? local.ses_dkim_records : {}

  domain = digitalocean_domain.environment[0].name
  type   = "CNAME"
  name   = each.key
  value  = each.value
  ttl    = 1800
}

resource "digitalocean_record" "catalog_assets" {
  count = local.is_staging ? 1 : 0

  domain = digitalocean_domain.environment[0].name
  type   = "CNAME"
  name   = "assets"
  value  = local.catalog_asset_cdn_endpoint
  ttl    = 3600
}

# Shadow validation hosts: always present once the DOKS load balancer target is
# known so the ingress + cert-manager pipeline can be proven while App Platform
# still serves the live hosts.
resource "digitalocean_record" "doks_ingress_shadow" {
  for_each = local.doks_shadow_records

  domain = local.environment_zone
  type   = "A"
  name   = each.value.name
  value  = var.doks_ingress_target
  ttl    = var.doks_ingress_ttl

  depends_on = [digitalocean_domain.environment]
}
