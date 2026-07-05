locals {
  environment_zone = "${var.environment}.${var.root_domain}"
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
  doks_ingress_records = var.doks_ingress_dns_enabled ? {
    apex = {
      name = "@"
      fqdn = local.environment_zone
    }
    www = {
      name = "www"
      fqdn = "www.${local.environment_zone}"
    }
    marketplace = {
      name = "marketplace"
      fqdn = "marketplace.${local.environment_zone}"
    }
    admin = {
      name = "admin"
      fqdn = "admin.${local.environment_zone}"
    }
  } : {}
}
