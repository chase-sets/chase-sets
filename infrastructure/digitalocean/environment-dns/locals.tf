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
  serving_from_doks              = var.staging_app_serving == "doks"

  # App-host leaf names inside the delegated staging child zone. "@" is the zone
  # apex (staging.chasesets.com); the others are the marketplace, admin, and
  # public-web surfaces App Platform serves today.
  doks_app_host_names = {
    apex        = "@"
    www         = "www"
    marketplace = "marketplace"
    admin       = "admin"
  }

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

  # Live-host cutover records exist only while serving is flipped to DOKS. Until
  # the flip, App Platform owns these names (apex is App-Platform-managed; www,
  # marketplace, and admin are the platform-root staging_app_alias CNAMEs), so
  # the default plan adds nothing here. Flipping staging_app_serving to "doks"
  # after the App Platform records are released is the instant cutover; flipping
  # back to "app-platform" is the rehearsed rollback.
  doks_serving_records = (local.doks_ingress_target_configured && local.serving_from_doks) ? {
    for key, name in local.doks_app_host_names :
    key => {
      name = name
      fqdn = name == "@" ? local.environment_zone : "${name}.${local.environment_zone}"
    }
  } : {}
}
