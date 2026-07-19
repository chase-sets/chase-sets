locals {
  is_staging       = var.environment == "staging"
  is_production    = var.environment == "production"
  environment_zone = local.is_production ? var.root_domain : "${var.environment}.${var.root_domain}"
  nameservers = [
    "ns1.digitalocean.com.",
    "ns2.digitalocean.com.",
    "ns3.digitalocean.com.",
  ]

  google_workspace_mx_records = {
    smtp = {
      priority = 1
      value    = "smtp.google.com."
    }
  }

  ses_dkim_records = {
    "cml3sn3hrope7qzwvbfbd2wybwv3lapt._domainkey" = "cml3sn3hrope7qzwvbfbd2wybwv3lapt.dkim.amazonses.com."
    "4ekj27577qp762adwkctyugeax5fl3se._domainkey" = "4ekj27577qp762adwkctyugeax5fl3se.dkim.amazonses.com."
    "w2va2svhfoffftm5uwyv76tdyd2hsjfn._domainkey" = "w2va2svhfoffftm5uwyv76tdyd2hsjfn.dkim.amazonses.com."
  }

  catalog_asset_cdn_endpoint = "chase-sets-${var.environment}-catalog-assets.${var.data_region}.cdn.digitaloceanspaces.com."

  doks_ingress_target_configured = trimspace(var.doks_ingress_target) != ""

  # Retain the established doks.* records as diagnostic aliases. Their state
  # identities and DNS values are intentionally unchanged by #4055; cleanup is
  # a separate delete-set and approval boundary.
  doks_diagnostic_records = local.doks_ingress_target_configured ? merge(
    {
      apex  = { name = "doks", fqdn = "doks.${local.environment_zone}" }
      www   = { name = "www.doks", fqdn = "www.doks.${local.environment_zone}" }
      admin = { name = "admin.doks", fqdn = "admin.doks.${local.environment_zone}" }
    },
    local.is_staging || var.production_marketplace_public_enabled ? {
      marketplace = { name = "marketplace.doks", fqdn = "marketplace.doks.${local.environment_zone}" }
    } : {},
  ) : {}

}
