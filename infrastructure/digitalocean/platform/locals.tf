locals {
  is_production       = var.environment == "production"
  is_staging          = var.environment == "staging"
  is_non_production   = !local.is_production
  environment_slug    = var.environment == "preview" ? var.preview_identifier : var.environment
  database_name_token = replace(local.environment_slug, "-", "_")
  name_prefix         = local.is_production ? "chase-sets" : "chase-sets-${local.environment_slug}"

  public_domains = local.is_production ? [
    var.root_domain,
    "www.${var.root_domain}",
    ] : [
    local.is_staging ? "www.${var.environment}.${var.root_domain}" : "${local.environment_slug}.preview.${var.root_domain}",
  ]

  legacy_public_redirect_domains = local.is_staging ? [
    "landing-${var.environment}.${var.root_domain}",
  ] : []

  marketplace_domains = local.is_non_production ? [
    local.is_staging ? "marketplace.${var.environment}.${var.root_domain}" : "marketplace.${local.environment_slug}.preview.${var.root_domain}",
  ] : []

  staging_root_marketplace_domains = local.is_staging ? [
    "${var.environment}.${var.root_domain}",
  ] : []
  all_marketplace_domains = concat(local.marketplace_domains, local.staging_root_marketplace_domains)

  admin_domain       = local.is_production ? "admin.${var.root_domain}" : local.is_staging ? "admin.${var.environment}.${var.root_domain}" : "admin.${local.environment_slug}.preview.${var.root_domain}"
  landing_domain     = local.public_domains[0]
  marketplace_domain = length(local.marketplace_domains) > 0 ? local.marketplace_domains[0] : null
  legacy_domain_redirects = local.is_staging ? {
    "landing-${var.environment}.${var.root_domain}"     = local.landing_domain
    "marketplace-${var.environment}.${var.root_domain}" = local.marketplace_domain
    "admin-${var.environment}.${var.root_domain}"       = local.admin_domain
  } : {}
  api_component_name = local.is_non_production ? "platform-api" : "admin-support-api"
  api_private_url    = local.is_non_production ? "$${platform-api.PRIVATE_URL}" : "$${admin-support-api.PRIVATE_URL}"
  marketplace_origin = local.marketplace_domain != null ? "https://${local.marketplace_domain}" : ""
  database_size      = local.is_non_production ? var.non_production_database_size : var.database_size

  api_database_pool_max               = "6"
  worker_database_pool_max            = local.is_non_production ? "8" : "6"
  bootstrap_database_pool_max         = "4"
  database_pool_idle_timeout_ms       = "5000"
  database_pool_connection_timeout_ms = "10000"
  worker_max_concurrent_runners       = "5"
  worker_projection_concurrency       = "2"
  worker_job_concurrency              = "1"
  worker_dispatch_concurrency         = "1"
  worker_scheduled_concurrency        = "1"
  catalog_asset_s3_endpoint           = "https://${var.region}.digitaloceanspaces.com"
  catalog_asset_s3_buckets = {
    preview    = "chase-sets-preview-catalog-assets"
    staging    = "chase-sets-staging-catalog-assets"
    production = "chase-sets-production-catalog-assets"
  }
  catalog_asset_public_base_urls = {
    preview    = "https://assets.preview.${var.root_domain}"
    staging    = "https://assets.staging.${var.root_domain}"
    production = "https://assets.${var.root_domain}"
  }
  catalog_asset_s3_bucket       = local.catalog_asset_s3_buckets[var.environment]
  catalog_asset_public_base_url = local.catalog_asset_public_base_urls[var.environment]

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

  default_context_database_connection_pool_sizes = {
    for context_name in local.context_names :
    context_name => 1
  }

  preview_context_database_connection_pool_sizes = merge(local.default_context_database_connection_pool_sizes, {
    auth            = 2
    catalog         = 2
    control         = 2
    identity        = 2
    public-presence = 2
  })

  staging_context_database_connection_pool_sizes = merge(local.default_context_database_connection_pool_sizes, {
    auth            = 3
    catalog         = 6
    control         = 4
    discovery       = 3
    identity        = 3
    marketplace     = 3
    notifications   = 2
    public-presence = 3
  })

  context_database_connection_pool_sizes = local.is_staging ? local.staging_context_database_connection_pool_sizes : (
    local.is_non_production ? local.preview_context_database_connection_pool_sizes : {}
  )

  non_production_connection_pool_contexts = local.is_non_production ? local.context_databases : {}

  context_database_urls = {
    for context_name in local.context_names :
    context_name => local.is_non_production ? format(
      "postgresql://%s:%s@%s:%d/%s?sslmode=require",
      urlencode(digitalocean_database_connection_pool.contexts[context_name].user),
      urlencode(coalesce(
        digitalocean_database_connection_pool.contexts[context_name].password,
        digitalocean_database_user.contexts[context_name].password,
      )),
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

  all_public_hostnames = concat(local.public_domains, keys(local.legacy_domain_redirects), local.all_marketplace_domains)
  ucp_route_prefixes   = ["/.well-known", "/ucp"]
  ucp_route_domains    = local.is_non_production ? concat(local.public_domains, [local.admin_domain], local.all_marketplace_domains) : []
  ucp_ingress_routes = {
    for route in setproduct(local.ucp_route_domains, local.ucp_route_prefixes) :
    "${route[0]}:${route[1]}" => {
      authority   = route[0]
      path_prefix = route[1]
    }
  }

  public_web_instances = local.is_production ? 2 : 1
  api_instances        = local.is_production ? 2 : 1
  admin_web_instances  = 1
  worker_instances     = 1
}
