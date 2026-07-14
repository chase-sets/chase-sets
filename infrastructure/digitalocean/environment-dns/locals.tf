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

  # Shadow validation hosts let the DOKS ingress controller and cert-manager
  # issue real certificates and pass end-to-end HTTPS probes while App Platform
  # keeps serving the live hosts. They are brand-new names App Platform never
  # manages, so they never collide with or destroy App Platform records. They
  # appear only once a load balancer target is known, which keeps the default
  # plan a no-op until an operator wires the DOKS load balancer.
  doks_shadow_records = local.doks_ingress_target_configured ? {
    apex        = { name = "doks", fqdn = "doks.${local.environment_zone}" }
    www         = { name = "www.doks", fqdn = "www.doks.${local.environment_zone}" }
    marketplace = { name = "marketplace.doks", fqdn = "marketplace.doks.${local.environment_zone}" }
    admin       = { name = "admin.doks", fqdn = "admin.doks.${local.environment_zone}" }
  } : {}

}
