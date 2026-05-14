locals {
  is_production       = var.environment == "production"
  is_non_production   = !local.is_production
  environment_slug    = var.environment == "preview" ? var.preview_identifier : var.environment
  database_name_token = replace(local.environment_slug, "-", "_")
  name_prefix         = local.is_production ? "chase-sets" : "chase-sets-${local.environment_slug}"

  public_domains = local.is_production ? [
    var.root_domain,
    "www.${var.root_domain}",
    ] : [
    "landing-${local.environment_slug}.${var.root_domain}",
  ]

  legacy_public_redirect_domains = []

  marketplace_domains = local.is_non_production ? [
    "marketplace-${local.environment_slug}.${var.root_domain}",
  ] : []

  admin_domain       = local.is_production ? "admin.${var.root_domain}" : "admin-${local.environment_slug}.${var.root_domain}"
  landing_domain     = local.public_domains[0]
  marketplace_domain = length(local.marketplace_domains) > 0 ? local.marketplace_domains[0] : null
  api_component_name = local.is_non_production ? "platform-api" : "admin-support-api"
  api_private_url    = local.is_non_production ? "$${platform-api.PRIVATE_URL}" : "$${admin-support-api.PRIVATE_URL}"
  marketplace_origin = local.marketplace_domain != null ? "https://${local.marketplace_domain}" : ""
  database_size      = local.is_non_production ? var.non_production_database_size : var.database_size

  database_pool_max                   = "1"
  database_pool_idle_timeout_ms       = "5000"
  database_pool_connection_timeout_ms = "10000"

  landing_context_names = [
    "auth",
    "catalog",
    "control",
    "experience",
    "identity",
    "public-presence",
  ]

  platform_context_names = [
    "auth",
    "catalog",
    "checkout",
    "commercial-terms",
    "control",
    "discovery",
    "experience",
    "fulfillment",
    "identity",
    "insights",
    "inventory",
    "marketplace",
    "notifications",
    "ordering",
    "payments",
    "pricing",
    "public-presence",
    "reputation",
    "settlement",
    "support",
  ]

  context_names = local.is_non_production ? local.platform_context_names : local.landing_context_names

  context_databases = {
    for context_name in local.context_names :
    context_name => "chase_sets_${local.database_name_token}_${replace(context_name, "-", "_")}"
  }

  context_database_users = {
    for context_name in local.context_names :
    context_name => "cs_${local.database_name_token}_${replace(context_name, "-", "_")}"
  }

  non_production_connection_pool_contexts = local.is_non_production ? local.context_databases : {}

  context_database_urls = {
    for context_name in local.context_names :
    context_name => local.is_non_production ? format(
      "postgresql://%s:%s@%s:%d/%s?sslmode=require",
      urlencode(digitalocean_database_connection_pool.contexts[context_name].user),
      urlencode(digitalocean_database_connection_pool.contexts[context_name].password),
      digitalocean_database_connection_pool.contexts[context_name].host,
      digitalocean_database_connection_pool.contexts[context_name].port,
      urlencode(digitalocean_database_connection_pool.contexts[context_name].name),
    ) : format("$${db-%s.DATABASE_URL}", context_name)
  }

  context_database_env = {
    for context_name in local.context_names :
    context_name => "DATABASE_URL_${upper(replace(context_name, "-", "_"))}"
    if context_name != "control"
  }

  all_public_hostnames = concat(local.public_domains, local.legacy_public_redirect_domains, local.marketplace_domains)

  public_web_instances = local.is_production ? 2 : 1
  api_instances        = local.is_production ? 2 : 1
  admin_web_instances  = 1
  worker_instances     = 1
}
