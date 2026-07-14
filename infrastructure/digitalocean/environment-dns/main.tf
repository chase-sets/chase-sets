resource "digitalocean_domain" "environment" {
  name = local.environment_zone

  lifecycle {
    prevent_destroy = true
  }
}

check "doks_ingress_serving_target" {
  assert {
    condition     = var.staging_app_serving != "doks" || local.doks_ingress_target_configured
    error_message = "doks_ingress_target must be set to the DOKS ingress load balancer IPv4 address before staging_app_serving flips to \"doks\"."
  }
}

resource "digitalocean_record" "delegation" {
  for_each = toset(local.nameservers)

  domain = var.root_domain
  type   = "NS"
  name   = var.environment
  value  = each.value
  ttl    = 1800
}

resource "digitalocean_record" "google_workspace_mx" {
  for_each = local.google_workspace_mx_records

  domain   = digitalocean_domain.environment.name
  type     = "MX"
  name     = "@"
  value    = each.value.value
  priority = each.value.priority
  ttl      = 14400
}

resource "digitalocean_record" "google_workspace_spf" {
  domain = digitalocean_domain.environment.name
  type   = "TXT"
  name   = "@"
  value  = "v=spf1 include:_spf.google.com ~all"
  ttl    = 14400
}

resource "digitalocean_record" "google_workspace_dkim" {
  count = var.google_workspace_dkim_txt_value == "" ? 0 : 1

  domain = digitalocean_domain.environment.name
  type   = "TXT"
  name   = "google._domainkey"
  value  = var.google_workspace_dkim_txt_value
  ttl    = 14400
}

resource "digitalocean_record" "dmarc" {
  domain = digitalocean_domain.environment.name
  type   = "TXT"
  name   = "_dmarc"
  value  = "v=DMARC1; p=none;"
  ttl    = 1800
}

resource "digitalocean_record" "ses_bounce_mx" {
  domain   = digitalocean_domain.environment.name
  type     = "MX"
  name     = "bounce"
  value    = "feedback-smtp.us-east-2.amazonses.com."
  priority = 10
  ttl      = 1800
}

resource "digitalocean_record" "ses_bounce_spf" {
  domain = digitalocean_domain.environment.name
  type   = "TXT"
  name   = "bounce"
  value  = "v=spf1 include:amazonses.com ~all"
  ttl    = 1800
}

resource "digitalocean_record" "ses_dkim" {
  for_each = local.ses_dkim_records

  domain = digitalocean_domain.environment.name
  type   = "CNAME"
  name   = each.key
  value  = each.value
  ttl    = 1800
}

resource "digitalocean_record" "catalog_assets" {
  domain = digitalocean_domain.environment.name
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

  domain = digitalocean_domain.environment.name
  type   = "A"
  name   = each.value.name
  value  = var.doks_ingress_target
  ttl    = var.doks_ingress_ttl
}
