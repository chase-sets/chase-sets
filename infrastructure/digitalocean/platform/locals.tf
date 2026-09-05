locals {
  is_production            = var.environment == "production"
  is_staging               = var.environment == "staging"
  is_preview               = var.environment == "preview"
  is_non_production        = !local.is_production
  managed_postgres_enabled = !local.is_preview
  placeholder_evidence_references = [
    "tbd",
    "todo",
    "none",
    "null",
    "n/a",
    "na",
    "placeholder",
    "example",
    "sample",
    "test",
    "ticket",
    "record",
    "launch-000",
  ]
  runtime_profile = local.is_non_production ? "public" : var.production_runtime_profile
  platform_enabled = (
    local.runtime_profile != "landing"
  )
  marketplace_public_enabled = (
    local.is_non_production || local.runtime_profile == "public"
  )
  environment_slug    = var.environment == "preview" ? var.preview_identifier : var.environment
  environment_zone    = "${var.environment}.${var.root_domain}"
  live_dns_zone       = local.is_production ? var.root_domain : local.environment_zone
  database_name_token = replace(local.environment_slug, "-", "_")
  name_prefix         = local.is_production ? "chase-sets" : "chase-sets-${local.environment_slug}"

  public_domains = local.is_production ? [
    var.root_domain,
    "www.${var.root_domain}",
    ] : [
    local.is_staging ? "www.${var.environment}.${var.root_domain}" : "${local.environment_slug}.preview.${var.root_domain}",
  ]

  marketplace_domains = local.marketplace_public_enabled ? [
    local.is_production ? "marketplace.${var.root_domain}" : local.is_staging ? "marketplace.${var.environment}.${var.root_domain}" : "marketplace.${local.environment_slug}.preview.${var.root_domain}",
  ] : []

  staging_root_marketplace_domains = local.is_staging ? [
    "${var.environment}.${var.root_domain}",
  ] : []
  all_marketplace_domains   = concat(local.marketplace_domains, local.staging_root_marketplace_domains)
  admin_domain              = local.is_production ? "admin.${var.root_domain}" : local.is_staging ? "admin.${var.environment}.${var.root_domain}" : "admin.${local.environment_slug}.preview.${var.root_domain}"
  landing_domain            = local.public_domains[0]
  database_size             = local.is_staging ? var.staging_database_size : var.database_size
  database_storage_size_mib = local.is_staging ? var.staging_database_storage_size_mib : null

  production_database_standby_desired_node_count = 2
  production_database_standby_posture = {
    desired_node_count       = local.production_database_standby_desired_node_count
    configured_node_count    = var.database_node_count
    approved                 = var.production_database_standby_approved
    approval_reference       = var.production_database_standby_reference
    traffic_posture          = "primary-only-runtime-bindings"
    read_traffic_to_standbys = false
    remaining_operator_action = (
      local.is_production && var.database_node_count < local.production_database_standby_desired_node_count
      ? "Record launch/cost approval plus a support-safe Terraform plan showing no deletes or replacements for digitalocean_database_cluster.postgres and context databases, then set database_node_count to 2."
      : ""
    )
  }
  managed_postgres_alert_policies = {
    disk_utilization = {
      description = "${local.name_prefix} managed Postgres disk utilization above 80% for 10m"
      type        = "v1/dbaas/alerts/disk_utilization_alerts"
      compare     = "GreaterThan"
      value       = 80
      window      = "10m"
    }
    memory_utilization = {
      description = "${local.name_prefix} managed Postgres memory utilization above 85% for 10m"
      type        = "v1/dbaas/alerts/memory_utilization_alerts"
      compare     = "GreaterThan"
      value       = 85
      window      = "10m"
    }
    cpu_utilization = {
      description = "${local.name_prefix} managed Postgres CPU utilization above 85% for 10m"
      type        = "v1/dbaas/alerts/cpu_alerts"
      compare     = "GreaterThan"
      value       = 85
      window      = "10m"
    }
    load_15 = {
      description = "${local.name_prefix} managed Postgres 15-minute load above 85 for 30m"
      type        = "v1/dbaas/alerts/load_15_alerts"
      compare     = "GreaterThan"
      value       = 85
      window      = "30m"
    }
  }
  observability_zone = local.is_production ? var.root_domain : local.environment_zone
  default_observability_otlp_endpoint = (
    local.is_production || local.is_staging ? "https://otel.${local.observability_zone}" : ""
  )
  observability_otlp_endpoint     = trimspace(var.observability_otlp_endpoint) != "" ? trimspace(var.observability_otlp_endpoint) : local.default_observability_otlp_endpoint
  observability_enabled           = var.observability_enabled && local.observability_otlp_endpoint != ""
  worker_listener_source_contexts = ["checkout", "identity", "inventory", "marketplace", "ordering", "payments", "public-presence"]
  api_waiter_contexts             = ["catalog", "discovery", "inventory", "marketplace"]
  wake_listener_contexts          = distinct(concat(local.worker_listener_source_contexts, local.api_waiter_contexts))
  wake_listener_database_users = (local.is_production || local.is_staging) ? {
    for context_name in local.wake_listener_contexts :
    context_name => "cs_${local.database_name_token}_${replace(context_name, "-", "_")}_wake_listener"
  } : {}
  # Wave-1 databases follow the standard context database naming (no token
  # overrides apply); the lookup keeps this evaluable in previews where the
  # wave-1 context databases are not managed.
  wake_listener_database_names = {
    for context_name in local.wake_listener_contexts :
    context_name => lookup(
      local.context_databases,
      context_name,
      "chase_sets_${local.database_name_token}_${replace(context_name, "-", "_")}",
    )
  }
  # Grants can only target databases Terraform manages in this configuration.
  # Production pre-provisions the canonical platform database set even while
  # route exposure remains landing-only; previews still skip unmanaged
  # listener databases.
  wake_listener_grant_contexts = [
    for context_name in local.wake_listener_contexts :
    context_name
    if contains(keys(local.wake_listener_database_users), context_name) && contains(keys(local.context_databases), context_name)
  ]
  worker_listener_database_urls = (local.is_production || local.is_staging) ? {
    for context_name in local.worker_listener_source_contexts :
    context_name => format(
      "postgresql://%s:%s@%s:%d/%s?sslmode=require",
      urlencode(digitalocean_database_user.wake_listeners[context_name].name),
      urlencode(digitalocean_database_user.wake_listeners[context_name].password),
      digitalocean_database_cluster.postgres[0].host,
      digitalocean_database_cluster.postgres[0].port,
      urlencode(local.wake_listener_database_names[context_name]),
    )
  } : {}
  api_waiter_database_urls = (local.is_production || local.is_staging) ? {
    for context_name in local.api_waiter_contexts :
    context_name => format(
      "postgresql://%s:%s@%s:%d/%s?sslmode=require",
      urlencode(digitalocean_database_user.wake_listeners[context_name].name),
      urlencode(digitalocean_database_user.wake_listeners[context_name].password),
      digitalocean_database_cluster.postgres[0].host,
      digitalocean_database_cluster.postgres[0].port,
      urlencode(local.wake_listener_database_names[context_name]),
    )
  } : {}

  # Read-after-write wake-before-wait rides a staging-first ramp: staging
  # proves the api-wait wake path before production enablement, which stays
  # gated behind the milestone rollout-control and canary evidence issues.
  catalog_asset_s3_endpoint = "https://${var.data_region}.digitaloceanspaces.com"
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
    "commercial-terms",
    "control",
    "fulfillment",
    "identity",
    "marketplace",
    "ordering",
    "platform-operations",
    "public-presence",
    "settlement",
  ]

  landing_exposed_route_context_names = [
    "auth",
    "catalog",
    "identity",
    "platform-operations",
    "public-presence",
  ]

  platform_context_names = [
    "auth",
    "authenticity",
    "catalog",
    "channels",
    "checkout",
    "collections",
    "commercial-terms",
    "control",
    "customer-feedback",
    "discovery",
    "fulfillment",
    "identity",
    "inventory",
    "marketplace",
    "notifications",
    "ordering",
    "payments",
    "platform-operations",
    "pricing",
    "public-presence",
    "settlement",
  ]

  active_runtime_context_names = local.platform_enabled ? local.platform_context_names : local.landing_context_names
  exposed_route_context_names  = local.platform_enabled ? local.platform_context_names : local.landing_exposed_route_context_names

  # Compatibility alias for existing runtime env maps and pools.
  context_names = local.active_runtime_context_names

  # Provisioning is intentionally wider than runtime exposure in production:
  # creating a context database/user must not imply mounting its routes or
  # running its workers. Production profile changes can move between landing,
  # proof, and public modes without planning deletion of canonical context
  # databases/users.
  production_additional_provisioned_context_names = [
    "reputation",
  ]

  production_provisioned_context_names = distinct(concat(
    local.platform_context_names,
    local.production_additional_provisioned_context_names,
  ))

  provisioned_context_names = local.is_production ? local.production_provisioned_context_names : local.active_runtime_context_names

  context_database_names = local.provisioned_context_names

  context_database_name_token_overrides = {
    "platform-operations" = "platform_ops"
  }

  context_database_name_tokens = {
    for context_name in local.context_database_names :
    context_name => (
      length("chase_sets_${local.database_name_token}_${replace(context_name, "-", "_")}") <= 40
      ? replace(context_name, "-", "_")
      : lookup(local.context_database_name_token_overrides, context_name, replace(context_name, "-", "_"))
    )
  }

  context_databases = {
    for context_name in local.context_database_names :
    context_name => "chase_sets_${local.database_name_token}_${local.context_database_name_tokens[context_name]}"
  }

  context_database_users = {
    for context_name in local.context_database_names :
    context_name => "cs_${local.database_name_token}_${replace(context_name, "-", "_")}"
  }

  managed_context_databases      = local.managed_postgres_enabled ? local.context_databases : {}
  managed_context_database_users = local.managed_postgres_enabled ? local.context_database_users : {}

  default_context_database_connection_pool_sizes = {
    for context_name in local.context_names :
    context_name => 1
  }

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

  # Production query-safe transaction pools (#4655): production adopts the
  # staging pooled shape with its own budget entries, sized for production's
  # lower worker/job concurrency (worker pool 8 with single job/operations
  # lanes) and two-instance API rather than staging's heavier drill lanes. The
  # per-context sizes are the server-side cluster-backend cap for each context's
  # pooled query traffic; the sum is the production PgBouncer allocation in the
  # connection-budget ledger. Only active runtime contexts get a query pool
  # (provisioned-but-inactive contexts such as reputation carry no query pool),
  # so the size map is keyed by local.context_names in every profile.
  production_context_database_connection_pool_size_overrides = {
    auth            = 2
    catalog         = 4
    checkout        = 2
    control         = 3
    discovery       = 2
    identity        = 2
    marketplace     = 3
    public-presence = 2
  }

  # The marketplace pool already serves the DOKS topology and remains durable
  # while production uses the landing profile. App Platform decommissioning
  # must not delete shared database infrastructure as a side effect.
  production_retained_connection_pool_context_names = ["marketplace"]
  production_connection_pool_context_names = distinct(concat(
    local.context_names,
    local.production_retained_connection_pool_context_names,
  ))
  production_context_database_connection_pool_sizes = {
    for context_name in local.production_connection_pool_context_names :
    context_name => lookup(local.production_context_database_connection_pool_size_overrides, context_name, 1)
  }

  # Previews provision no managed transaction pools: they have no DigitalOcean
  # managed cluster in this root (#4656), so the size map is empty outside the
  # managed-postgres environments and connection_pool_contexts below is empty
  # for preview plans.
  context_database_connection_pool_sizes = local.is_staging ? local.staging_context_database_connection_pool_sizes : (
    local.is_production ? local.production_context_database_connection_pool_sizes : {}
  )

  # Every environment now provisions managed transaction pools for its active
  # runtime contexts (#4655 added production); production also retains the
  # existing DOKS marketplace pool while the landing profile hides its routes.
  # The pool set matches the sized contexts exactly so every pool is budgeted.
  connection_pool_contexts = toset(keys(local.context_database_connection_pool_sizes))

  preview_postgres_host = "chase-sets-preview-postgres"
  # The in-cluster preview Postgres does not serve SSL, so preview URLs state
  # sslmode=disable explicitly; managed staging/production URLs keep
  # sslmode=require.
  preview_context_database_urls = {
    for context_name in local.context_database_names :
    context_name => format(
      "postgresql://%s:preview-app@%s:5432/%s?sslmode=disable",
      urlencode(local.context_database_users[context_name]),
      local.preview_postgres_host,
      urlencode(local.context_databases[context_name]),
    )
  }

  # Query traffic runs through the managed transaction pools in every
  # managed-postgres environment (#4655); previews synthesize namespace-local
  # in-cluster Postgres URLs instead (#4656). Waiter and relay listener URLs
  # stay direct (built from the wake-listener users on the cluster host)
  # because LISTEN is incompatible with transaction pooling.
  context_database_urls = local.is_preview ? local.preview_context_database_urls : {
    for context_name in local.context_names :
    context_name => format(
      "postgresql://%s:%s@%s:%d/%s?sslmode=require",
      urlencode(digitalocean_database_connection_pool.contexts[context_name].user),
      urlencode(coalesce(
        digitalocean_database_connection_pool.contexts[context_name].password,
        digitalocean_database_user.contexts[context_name].password,
      )),
      digitalocean_database_connection_pool.contexts[context_name].host,
      digitalocean_database_connection_pool.contexts[context_name].port,
      urlencode(digitalocean_database_connection_pool.contexts[context_name].name),
    )
  }

  context_database_env = {
    for context_name in local.context_names :
    context_name => "DATABASE_URL_${upper(replace(context_name, "-", "_"))}"
    if context_name != "control"
  }

  context_waiter_database_env = {
    for context_name in local.api_waiter_contexts :
    context_name => "DATABASE_URL_${upper(replace(context_name, "-", "_"))}_WAITER"
  }

  public_uptime_check_targets = {
    for domain in local.public_domains :
    "public-${replace(domain, ".", "-")}" => "https://${domain}"
  }
  admin_uptime_check_targets = {
    (format("admin-%s", replace(local.admin_domain, ".", "-"))) = "https://${local.admin_domain}/health/ready"
  }
  production_retained_marketplace_uptime_check_targets = local.is_production ? {
    "marketplace-${replace("marketplace.${var.root_domain}", ".", "-")}" = "https://marketplace.${var.root_domain}/health/ready"
  } : {}
  marketplace_uptime_check_targets = merge({
    for domain in local.all_marketplace_domains :
    "marketplace-${replace(domain, ".", "-")}" => "https://${domain}/health/ready"
  }, local.production_retained_marketplace_uptime_check_targets)
  uptime_check_targets = merge(
    local.public_uptime_check_targets,
    local.admin_uptime_check_targets,
    local.marketplace_uptime_check_targets,
  )
  app_serving_record_names = local.is_staging ? toset([
    "admin",
    "marketplace",
    "www",
    ]) : local.is_production ? toset(concat(
    ["admin", "www"],
    local.marketplace_public_enabled ? ["marketplace"] : [],
  )) : toset([])
}
