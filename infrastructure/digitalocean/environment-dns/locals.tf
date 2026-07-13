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

  doks_ingress_target_configured = trimspace(var.doks_ingress_target) != ""

  # Live DOKS host names inside the delegated staging child zone. "@" is the
  # zone apex (staging.chasesets.com).
  doks_app_host_names = {
    apex        = "@"
    www         = "www"
    marketplace = "marketplace"
    admin       = "admin"
  }

  doks_serving_records = local.doks_ingress_target_configured ? {
    for key, name in local.doks_app_host_names :
    key => {
      name = name
      fqdn = name == "@" ? local.environment_zone : "${name}.${local.environment_zone}"
    }
  } : {}
}
