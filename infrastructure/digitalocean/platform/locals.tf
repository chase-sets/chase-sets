locals {
  is_production     = var.environment == "production"
  is_staging        = var.environment == "staging"
  is_non_production = !local.is_production
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
  marketplace_platform_enabled = (
    local.is_non_production ||
    var.production_marketplace_public_enabled ||
    var.production_marketplace_proof_enabled
  )
  marketplace_public_enabled = (
    local.is_non_production || var.production_marketplace_public_enabled
  )
  production_proof_web_enabled = (
    local.is_production &&
    var.production_marketplace_proof_enabled &&
    !var.production_marketplace_public_enabled
  )
  marketplace_web_enabled = (
    local.marketplace_public_enabled || local.production_proof_web_enabled
  )
  environment_slug    = var.environment == "preview" ? var.preview_identifier : var.environment
  environment_zone    = "${var.environment}.${var.root_domain}"
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

  marketplace_domains = local.marketplace_web_enabled ? [
    local.is_production ? "marketplace.${var.root_domain}" : local.is_staging ? "marketplace.${var.environment}.${var.root_domain}" : "marketplace.${local.environment_slug}.preview.${var.root_domain}",
  ] : []

  staging_root_marketplace_domains = local.is_staging ? [
    "${var.environment}.${var.root_domain}",
  ] : []
  all_marketplace_domains = concat(local.marketplace_domains, local.staging_root_marketplace_domains)
  app_primary_domain      = local.is_staging ? local.staging_root_marketplace_domains[0] : local.public_domains[0]

  admin_domain       = local.is_production ? "admin.${var.root_domain}" : local.is_staging ? "admin.${var.environment}.${var.root_domain}" : "admin.${local.environment_slug}.preview.${var.root_domain}"
  landing_domain     = local.public_domains[0]
  marketplace_domain = length(local.marketplace_domains) > 0 ? local.marketplace_domains[0] : null
  legacy_domain_redirects = local.is_staging ? {
    "landing-${var.environment}.${var.root_domain}"     = local.landing_domain
    "marketplace-${var.environment}.${var.root_domain}" = local.marketplace_domain
    "admin-${var.environment}.${var.root_domain}"       = local.admin_domain
  } : {}
  api_component_name            = local.marketplace_public_enabled ? "platform-api" : "admin-support-api"
  api_private_url               = local.marketplace_public_enabled ? "$${platform-api.PRIVATE_URL}" : "$${admin-support-api.PRIVATE_URL}"
  platform_api_private_url      = local.marketplace_platform_enabled ? "$${platform-api.PRIVATE_URL}" : local.api_private_url
  admin_web_internal_api_origin = local.marketplace_platform_enabled ? local.platform_api_private_url : local.api_private_url
  marketplace_origin            = local.marketplace_domain != null ? "https://${local.marketplace_domain}" : ""
  database_size                 = local.is_staging ? var.staging_database_size : (local.is_non_production ? var.non_production_database_size : var.database_size)
  observability_zone            = local.is_production ? var.root_domain : local.environment_zone
  default_observability_otlp_endpoint = (
    local.is_production || local.is_staging ? "https://otel.${local.observability_zone}" : ""
  )
  observability_otlp_endpoint = trimspace(var.observability_otlp_endpoint) != "" ? trimspace(var.observability_otlp_endpoint) : local.default_observability_otlp_endpoint
  observability_enabled       = var.observability_enabled && local.observability_otlp_endpoint != ""
  observability_runtime_env = local.observability_enabled ? {
    OBSERVABILITY_ENABLED = {
      value  = "true"
      secret = false
    }
    OTEL_EXPORTER_OTLP_ENDPOINT = {
      value  = local.observability_otlp_endpoint
      secret = false
    }
    OTEL_EXPORTER_OTLP_HEADERS = {
      value  = var.observability_otlp_headers
      secret = true
    }
    OTEL_RESOURCE_ATTRIBUTES = {
      value  = "cloud.provider=digitalocean,cloud.platform=digitalocean_app_platform,chase_sets.environment_slug=${local.environment_slug}"
      secret = false
    }
    } : {
    OBSERVABILITY_ENABLED = {
      value  = "false"
      secret = false
    }
  }

  api_database_pool_max               = "6"
  worker_default_database_pool_max    = local.is_staging ? 11 : 8
  worker_database_pool_max            = tostring(var.worker_database_pool_max > 0 ? var.worker_database_pool_max : local.worker_default_database_pool_max)
  bootstrap_database_pool_max         = "4"
  database_pool_idle_timeout_ms       = "5000"
  database_pool_connection_timeout_ms = "10000"
  worker_max_concurrent_runners       = local.is_staging ? "8" : "5"
  worker_projection_concurrency       = "2"
  worker_default_job_concurrency      = local.is_staging ? 4 : 1
  worker_job_concurrency              = tostring(var.worker_job_concurrency > 0 ? var.worker_job_concurrency : local.worker_default_job_concurrency)
  worker_inventory_import_concurrency = "1"
  worker_dispatch_concurrency         = "1"
  worker_scheduled_concurrency        = "1"
  # Hot-lane reserved capacity (#1223): the wakes loop reserves
  # min(hot lane runner count, wake concurrency - 1) slots for hot-lane wake
  # runners, so wake concurrency must be at least hot lanes + 1 for the
  # reservation to be real while standard/bulk keep a slot. Production runs 2
  # like staging so the reservation is provisioned before production proof
  # mode (#1237) enables the relay; the worker_runner_capacity check sums
  # production runner concurrency to 8 = worker_database_pool_max and staging
  # to 11 = worker_database_pool_max.
  worker_wake_concurrency           = "2"
  worker_wake_hot_lane_runners      = "1"
  worker_wake_standard_lane_runners = "1"
  worker_wake_bulk_lane_runners     = "1"
  worker_wake_statement_timeout_ms  = "30000"

  # Direct listener URLs for the worker-owned projection wake relay (wave-1
  # source contexts). LISTEN is incompatible with PgBouncer transaction
  # pooling, so staging and production both use direct cluster URLs built from
  # dedicated least-privilege wake-listener users (#1243): CONNECT for LISTEN
  # plus read-only event-store grants, never the owning context users or the
  # full-DML App Platform bindings. Previews intentionally omit listener URLs:
  # push rollout never targets preview environments and the relay falls back
  # to catch-up-only behavior.
  worker_listener_source_contexts = ["checkout", "inventory", "marketplace", "ordering", "payments"]
  wake_listener_database_users = (local.is_production || local.is_staging) ? {
    for context_name in local.worker_listener_source_contexts :
    context_name => "cs_${local.database_name_token}_${replace(context_name, "-", "_")}_wake_listener"
  } : {}
  # Wave-1 databases follow the standard context database naming (no token
  # overrides apply); the lookup keeps this evaluable in landing-only
  # production where the wave-1 context databases are not yet managed.
  wake_listener_database_names = {
    for context_name in local.worker_listener_source_contexts :
    context_name => lookup(
      local.context_databases,
      context_name,
      "chase_sets_${local.database_name_token}_${replace(context_name, "-", "_")}",
    )
  }
  # Grants can only target databases Terraform manages in this configuration;
  # landing-only production (no marketplace platform contexts) skips them and
  # the grants resource re-runs when proof mode creates the databases because
  # its triggers include the database/user ids.
  wake_listener_grant_contexts = [
    for context_name in local.worker_listener_source_contexts :
    context_name
    if contains(keys(local.wake_listener_database_users), context_name) && contains(keys(local.context_databases), context_name)
  ]
  worker_listener_database_urls = (local.is_production || local.is_staging) ? {
    for context_name in local.worker_listener_source_contexts :
    context_name => format(
      "postgresql://%s:%s@%s:%d/%s?sslmode=require",
      urlencode(digitalocean_database_user.wake_listeners[context_name].name),
      urlencode(digitalocean_database_user.wake_listeners[context_name].password),
      digitalocean_database_cluster.postgres.host,
      digitalocean_database_cluster.postgres.port,
      urlencode(local.wake_listener_database_names[context_name]),
    )
  } : {}

  # Read-after-write wake-before-wait rides a staging-first ramp: staging
  # proves the api-wait wake path before production enablement, which stays
  # gated behind the milestone rollout-control and canary evidence issues.
  read_consistency_wake_before_wait_enabled = local.is_staging ? "true" : "false"

  # The source-context wake registry is environment-global, so push rollout is
  # environment-gated here: staging runs the full push loop for the enabled
  # wave-1 contexts, while production and previews keep both the relay and
  # write-side event-store wake emission killed until the production proof
  # gates (#1243/#1244/#1237) pass.
  worker_projection_wake_relay_enabled   = local.is_staging ? "true" : "false"
  event_store_wake_notifications_enabled = local.is_staging ? "true" : "false"

  # --- Push-wake connection budget (#1244, #1243, #1236) ---------------------
  # Plan-time model of worst-case DigitalOcean managed Postgres backend demand
  # for the push-first projection wake topology. The same locals drive every
  # environment; only scale knobs (instance counts, pool sizes, database size)
  # and the staging-first ramp flags differ, so staging exercises the same
  # logical query/listener/control-plane shape production runs (#1243).
  # Ledger and assumptions: docs/architecture/push-wake-connection-budget.md.
  #
  # Connection semantics being modeled:
  # - Non-production app components (API/worker/bootstrap) connect through the
  #   managed PgBouncer transaction pools. Those are client-side connections;
  #   the cluster backends they can occupy are capped by the server-side pool
  #   sizes in context_database_connection_pool_sizes, not by app pool maxima.
  # - Production app components use App Platform database bindings, which are
  #   direct session-compatible cluster connections, so app pool maxima count
  #   directly against cluster backends.
  # - Relay listener URLs are direct in every environment that defines them,
  #   because LISTEN is incompatible with transaction pooling.
  # - DATABASE_POOL_MAX is a per-database-URL cap (one node-postgres pool per
  #   context database), not a per-process aggregate. The budget treats it as
  #   the per-process concurrent-backend allowance: worker runner concurrency
  #   is held at or below the pool max by check "worker_runner_capacity", API
  #   concurrency is bounded by in-flight requests, and the 5s pool idle
  #   timeout reaps idle backends. The headroom asserted by
  #   check "wake_connection_budget" absorbs bursts above that allowance.

  # Production proof mode deploys the platform-* and admin-support-* component
  # families at the same time, so production budgets both families even when a
  # gate currently deploys only one; flipping the proof/public switches can
  # never grow demand past this worst case. Staging and previews only ever
  # deploy the platform-* family.
  api_component_count    = local.is_production ? 2 : 1
  worker_component_count = local.is_production ? 2 : 1

  # Worst-case app-side pool demand (per-process pool max x component count x
  # instances). Direct cluster backends in production; PgBouncer client-side
  # connections in non-production.
  api_total_pool_demand    = tonumber(local.api_database_pool_max) * local.api_component_count * local.api_instances
  worker_total_pool_demand = tonumber(local.worker_database_pool_max) * local.worker_component_count * local.worker_instances

  # Direct LISTEN connections held by the single active worker-owned relay,
  # one per wave-1 source context. Production defines dedicated wake-listener
  # URLs while the relay stays killed; budget the relay-enabled worst case
  # anyway so flipping WORKER_PROJECTION_WAKE_RELAY_ENABLED later cannot
  # violate the budget. Previews define no listener URLs and budget zero.
  relay_listener_demand = (local.is_production || local.is_staging) ? length(local.worker_listener_source_contexts) : 0

  # Bootstrap PRE_DEPLOY jobs are transient (single instance, finished before
  # replacement app containers start) but still occupy backends while running,
  # so the budget reserves one bootstrap pool. In staging the bootstrap job
  # itself rides the PgBouncer pool URLs (already capped by the server-side
  # allocation below); the reservation there covers the direct admin
  # connection used by the Terraform database-grant local-exec and ad hoc
  # direct maintenance access.
  bootstrap_demand = tonumber(local.bootstrap_database_pool_max)

  # Server-side PgBouncer backend allocation: a DigitalOcean managed pool's
  # "size" is the number of cluster backends that pool may hold, so the sum of
  # configured pool sizes is the worst-case backend footprint of all pooled
  # app traffic in non-production. Production attaches no managed pools.
  pgbouncer_server_backend_allocation = (
    length(local.context_database_connection_pool_sizes) > 0
    ? sum(values(local.context_database_connection_pool_sizes))
    : 0
  )

  # DigitalOcean managed Postgres backend connection limits by size, minus a
  # conservative 3-connection reservation for DigitalOcean maintenance
  # (documented totals: db-s-1vcpu-1gb=22, db-s-1vcpu-2gb=47,
  # db-s-2vcpu-4gb=97, db-s-4vcpu-8gb=197). A database size missing from this
  # map resolves to 0 and fails check "wake_connection_budget" until the new
  # tier is budgeted here.
  cluster_connection_limits = {
    "db-s-1vcpu-1gb" = 19
    "db-s-1vcpu-2gb" = 44
    "db-s-2vcpu-4gb" = 94
    "db-s-4vcpu-8gb" = 194
  }
  cluster_connection_limit = lookup(local.cluster_connection_limits, local.database_size, 0)

  # Worst-case steady-state direct cluster backend demand. Production bindings
  # are all direct, so every app pool counts; in non-production only the
  # PgBouncer server-side allocation, the direct relay listeners, and the
  # bootstrap reservation reach the cluster.
  cluster_backend_demand = local.is_production ? (
    local.api_total_pool_demand + local.worker_total_pool_demand + local.relay_listener_demand + local.bootstrap_demand
    ) : (
    local.pgbouncer_server_backend_allocation + local.relay_listener_demand + local.bootstrap_demand
  )

  # Rolling-deploy overlap envelope: App Platform starts replacement
  # containers before stopping the old ones, so direct app backends and relay
  # listener connections can momentarily double. The PgBouncer server-side
  # allocation does not grow with client count, which is exactly why
  # non-production query traffic stays on pooled URLs.
  cluster_backend_demand_deploy_overlap = local.is_production ? (
    2 * (local.api_total_pool_demand + local.worker_total_pool_demand) + 2 * local.relay_listener_demand + local.bootstrap_demand
    ) : (
    local.pgbouncer_server_backend_allocation + 2 * local.relay_listener_demand + local.bootstrap_demand
  )

  source_observation_bulk_job_lanes             = local.is_staging ? "4" : "1"
  source_observation_bulk_workflow_cap          = local.is_staging ? "4" : "1"
  source_observation_bulk_job_cap               = local.is_staging ? "2" : "1"
  catalog_authoring_bulk_job_lanes              = local.is_staging ? "3" : "1"
  catalog_authoring_bulk_workflow_cap           = local.is_staging ? "3" : "1"
  catalog_authoring_bulk_job_cap                = local.is_staging ? "2" : "1"
  source_observation_integration_job_lanes      = local.is_staging ? "4" : "1"
  source_observation_integration_workflow_cap   = local.is_staging ? "4" : "1"
  source_observation_integration_job_cap        = local.is_staging ? "2" : "1"
  inventory_import_batch_job_lanes              = local.is_staging ? "4" : "1"
  inventory_import_batch_workflow_cap           = local.is_staging ? "4" : "1"
  inventory_import_batch_job_cap                = local.is_staging ? "2" : "1"
  pricing_recommendation_job_lanes              = local.is_staging ? "3" : "1"
  pricing_recommendation_workflow_cap           = local.is_staging ? "3" : "1"
  pricing_recommendation_job_cap                = local.is_staging ? "2" : "1"
  settlement_payout_reconciliation_job_lanes    = local.is_staging ? "2" : "1"
  settlement_payout_reconciliation_workflow_cap = local.is_staging ? "2" : "1"
  settlement_payout_reconciliation_job_cap      = "1"
  realtime_stream_limiter                       = local.is_non_production ? "local" : "postgres"
  catalog_asset_s3_endpoint                     = "https://${var.data_region}.digitaloceanspaces.com"
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
  catalog_provider_runtime_env = {
    TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE = {
      value  = var.tcgplayer_automation_tcg_auth_cookie
      secret = true
    }
    SCRYDEX_API_KEY = {
      value  = var.scrydex_api_key
      secret = true
    }
    SCRYDEX_TEAM_ID = {
      value  = var.scrydex_team_id
      secret = true
    }
    TCGPLAYER_AUTOMATION_REQUEST_DELAY_MS = {
      value  = "250"
      secret = false
    }
    TCGPLAYER_AUTOMATION_RATE_LIMIT_COOLDOWN_MS = {
      value  = "30000"
      secret = false
    }
    TCGPLAYER_AUTOMATION_MAX_CONCURRENT_REQUESTS = {
      value  = "2"
      secret = false
    }
    TCGPLAYER_AUTOMATION_MAX_RETRIES = {
      value  = "3"
      secret = false
    }
    CATALOG_INTEGRATION_CONTROL_PLANE_MODE = {
      value  = local.is_production ? "dry-run-only" : "open"
      secret = false
    }
    CATALOG_INTEGRATION_ACTIVATION_MODE = {
      value  = local.is_production ? "test-profiles-only" : "open"
      secret = false
    }
    CATALOG_INTEGRATION_IMPORTS_DISABLED = {
      value  = local.is_production ? "mtgjson,scryfall,tcgplayer" : ""
      secret = false
    }
    CATALOG_INTEGRATION_PROMOTION_DISABLED = {
      value  = local.is_production ? "mtgjson,scryfall,tcgplayer" : ""
      secret = false
    }
    CATALOG_INTEGRATION_REAPPLY_DISABLED = {
      value  = local.is_production ? "mtgjson,scryfall,tcgplayer" : ""
      secret = false
    }
    CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP = {
      value  = ""
      secret = false
    }
    CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES = {
      value  = "open"
      secret = false
    }
  }

  landing_context_names = [
    "auth",
    "catalog",
    "control",
    "identity",
    "platform-operations",
    "public-presence",
  ]

  platform_context_names = [
    "auth",
    "catalog",
    "checkout",
    "commercial-terms",
    "control",
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

  context_names = local.marketplace_platform_enabled ? local.platform_context_names : local.landing_context_names

  production_retained_context_database_names = [
    "reputation",
  ]

  context_database_names = distinct(concat(
    local.context_names,
    local.is_production ? local.production_retained_context_database_names : [],
  ))

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

  context_database_connection_pool_sizes = local.is_staging ? local.staging_context_database_connection_pool_sizes : (
    local.is_non_production ? local.default_context_database_connection_pool_sizes : {}
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
  ucp_route_domains    = local.marketplace_public_enabled ? concat(local.public_domains, [local.admin_domain], local.all_marketplace_domains) : []
  provider_webhook_route_prefixes = [
    "/api/payments/provider/webhooks",
    "/api/settlement/provider/money-movement/webhooks",
    "/api/notifications/provider/email/webhooks",
    "/api/fulfillment/provider/postage/webhooks",
  ]
  provider_webhook_route_domains = local.marketplace_platform_enabled ? distinct(concat(
    local.public_domains,
    [local.admin_domain],
    local.all_marketplace_domains,
  )) : []
  provider_webhook_ingress_routes = {
    for route in setproduct(local.provider_webhook_route_domains, local.provider_webhook_route_prefixes) :
    "${route[0]}:${route[1]}" => {
      authority   = route[0]
      path_prefix = route[1]
    }
  }
  proof_api_route_prefixes = [
    "/api/marketplace/account/sales/shipments",
    "/api/inventory/items/listing-stock/ensure",
    "/api/inventory/storage-locations",
    "/api/marketplace/account/listing-availability",
    "/api/marketplace/account/listing-inventory",
    "/api/marketplace/account/listings",
    "/api/marketplace/account/checkout",
    "/api/marketplace/account/checkout-sessions",
    "/api/marketplace/account/marketplace-checkout-fee-policy",
    "/api/marketplace/account/payments",
    "/api/marketplace/account/provider-events",
    "/api/marketplace/account/provider-health",
    "/api/marketplace/account/provider-idempotency",
    "/api/marketplace/account/purchases/checkout",
    "/api/marketplace/account/reconciliation",
    "/api/settlement/account-status",
    "/api/settlement/money-health",
    "/api/settlement/payout-readiness",
    "/api/settlement/payout-setup",
    "/api/settlement/payouts",
    "/api/settlement/provider-health",
    "/api/settlement/wallet",
  ]
  proof_api_route_domains = local.is_production && var.production_marketplace_proof_enabled && !var.production_marketplace_public_enabled ? distinct(concat(
    local.public_domains,
    [local.admin_domain],
  )) : []
  proof_api_ingress_routes = {
    for route in setproduct(local.proof_api_route_domains, local.proof_api_route_prefixes) :
    "${route[0]}:${route[1]}" => {
      authority   = route[0]
      path_prefix = route[1]
    }
  }
  proof_admin_api_route_prefixes = [
    "/api/catalog",
    "/api/commercial-terms",
    "/api/platform",
    "/api/public-presence",
    "/api/realtime",
  ]
  proof_admin_api_route_domains = local.is_production && var.production_marketplace_proof_enabled && !var.production_marketplace_public_enabled ? [
    local.admin_domain,
  ] : []
  proof_admin_api_ingress_routes = {
    for route in setproduct(local.proof_admin_api_route_domains, local.proof_admin_api_route_prefixes) :
    "${route[0]}:${route[1]}" => {
      authority   = route[0]
      path_prefix = route[1]
    }
  }
  proof_web_route_prefixes = [
    "/account/payouts/setup",
  ]
  proof_web_route_domains = local.production_proof_web_enabled ? distinct(concat(
    local.public_domains,
    [local.admin_domain],
  )) : []
  proof_web_ingress_routes = {
    for route in setproduct(local.proof_web_route_domains, local.proof_web_route_prefixes) :
    "${route[0]}:${route[1]}" => {
      authority   = route[0]
      path_prefix = route[1]
    }
  }
  app_domain_zones = merge(
    {
      for domain in local.public_domains :
      domain => local.is_staging ? local.environment_zone : var.root_domain
    },
    {
      for domain in keys(local.legacy_domain_redirects) :
      domain => var.root_domain
    },
    {
      for domain in local.marketplace_domains :
      domain => local.is_staging ? local.environment_zone : var.root_domain
    },
    {
      for domain in local.staging_root_marketplace_domains :
      domain => local.environment_zone
    },
    {
      (local.admin_domain) = local.is_staging ? local.environment_zone : var.root_domain
    },
  )
  staging_app_alias_record_names = local.is_staging ? toset([
    "admin",
    "marketplace",
    "www",
  ]) : toset([])
  ucp_ingress_routes = {
    for route in setproduct(local.ucp_route_domains, local.ucp_route_prefixes) :
    "${route[0]}:${route[1]}" => {
      authority   = route[0]
      path_prefix = route[1]
    }
  }

  public_web_instances              = local.is_production ? 2 : 1
  api_instances                     = local.is_production ? 2 : 1
  admin_web_instances               = 1
  worker_default_instance_size_slug = local.is_staging ? "apps-s-1vcpu-2gb" : var.app_instance_size_slug
  worker_instance_size_slug         = trimspace(var.worker_instance_size_slug) != "" ? var.worker_instance_size_slug : local.worker_default_instance_size_slug
  default_worker_instances          = local.is_staging ? 2 : 1
  worker_instances                  = var.worker_instance_count > 0 ? var.worker_instance_count : local.default_worker_instances

  public_uptime_check_targets = {
    for domain in local.public_domains :
    "public-${replace(domain, ".", "-")}" => "https://${domain}"
  }
  admin_uptime_check_targets = {
    (format("admin-%s", replace(local.admin_domain, ".", "-"))) = "https://${local.admin_domain}/health/ready"
  }
  marketplace_uptime_check_targets = {
    for domain in local.all_marketplace_domains :
    "marketplace-${replace(domain, ".", "-")}" => "https://${domain}/health/ready"
  }
  uptime_check_targets = merge(
    local.public_uptime_check_targets,
    local.admin_uptime_check_targets,
    local.marketplace_uptime_check_targets,
  )
}
