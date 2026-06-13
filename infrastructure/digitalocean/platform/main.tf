moved {
  from = digitalocean_app.landing
  to   = digitalocean_app.platform
}

resource "digitalocean_database_cluster" "postgres" {
  name       = "${local.name_prefix}-postgres"
  engine     = "pg"
  version    = var.postgres_version
  size       = local.database_size
  region     = var.data_region
  node_count = var.database_node_count
  tags       = [var.environment, "platform", "managed-by-terraform"]
}

check "api_realtime_coordination" {
  assert {
    condition     = local.api_instances <= 1 || local.realtime_stream_limiter != "local"
    error_message = "API instance_count cannot exceed 1 while REALTIME_STREAM_LIMITER is local; use a shared limiter before horizontal API scaling."
  }
}

check "context_database_name_lengths" {
  assert {
    condition     = alltrue([for database_name in values(local.context_databases) : length(database_name) <= 40])
    error_message = "DigitalOcean context database names must be 40 characters or fewer; add an explicit token override for long bounded-context names."
  }
}

check "production_marketplace_proof" {
  assert {
    condition = !var.production_marketplace_proof_enabled || (
      var.environment == "production" &&
      length(trimspace(var.production_marketplace_proof_reference)) >= 6 &&
      !contains(local.placeholder_evidence_references, lower(trimspace(var.production_marketplace_proof_reference)))
    )
    error_message = "Production marketplace proof mode requires a production environment and a real evidence-collection approval reference."
  }
}

check "staging_production_observability_export" {
  assert {
    condition = !(local.is_staging || local.is_production) || !var.observability_enabled || (
      trimspace(local.observability_otlp_endpoint) != "" &&
      trimspace(var.observability_otlp_headers) != ""
    )
    error_message = "Staging and production telemetry export requires an OTLP endpoint and observability_otlp_headers write credential."
  }
}

check "production_marketplace_promotion" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.notification_email_provider == "amazon-ses" &&
      trimspace(var.ses_aws_region) != "" &&
      trimspace(var.ses_aws_access_key_id) != "" &&
      trimspace(var.ses_aws_secret_access_key) != "" &&
      trimspace(var.ses_from_email) != "" &&
      trimspace(var.ses_configuration_set_name) != "" &&
      trimspace(var.ses_source_arn) != ""
    )
    error_message = "Production marketplace promotion requires production environment and complete Amazon SES transactional email configuration."
  }
}

check "production_marketplace_launch_approval" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.production_marketplace_promotion_approved &&
      trimspace(var.production_marketplace_promotion_reference) != ""
    )
    error_message = "Production marketplace promotion requires an approved marketplace promotion record before deploying the public marketplace."
  }
}

check "production_marketplace_evidence_reference_quality" {
  assert {
    condition = !var.production_marketplace_public_enabled || alltrue([
      for reference in [
        var.production_marketplace_promotion_reference,
        var.production_marketplace_checkout_fee_reference,
        var.production_checkout_launch_evidence_reference,
        var.production_stripe_money_operations_reference,
        var.production_support_operations_reference,
        var.production_fulfillment_postage_reference,
        var.production_transactional_email_reference,
        var.production_launch_supply_measurements_reference,
        var.production_tax_readiness_reference,
      ] : length(trimspace(reference)) >= 6 && !contains(local.placeholder_evidence_references, lower(trimspace(reference)))
    ])
    error_message = "Production marketplace promotion evidence references must point to real external evidence records, not placeholders."
  }
}

check "production_marketplace_checkout_fee_approval" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.production_marketplace_checkout_fee_approved &&
      trimspace(var.production_marketplace_checkout_fee_reference) != ""
    )
    error_message = "Production marketplace promotion requires approved Marketplace Checkout Fee evidence before live checkout."
  }
}

check "production_checkout_launch_evidence_readiness" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.production_checkout_launch_evidence_approved &&
      trimspace(var.production_checkout_launch_evidence_reference) != ""
    )
    error_message = "Production marketplace promotion requires approved checkout launch evidence before public checkout."
  }
}

check "production_stripe_money_operations_readiness" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.production_stripe_money_operations_approved &&
      trimspace(var.production_stripe_money_operations_reference) != ""
    )
    error_message = "Production marketplace promotion requires approved Stripe money operations evidence before live payments and payouts."
  }
}

check "production_support_operations_readiness" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.production_support_operations_approved &&
      trimspace(var.production_support_operations_reference) != ""
    )
    error_message = "Production marketplace promotion requires approved Support operations evidence before live order support."
  }
}

check "production_fulfillment_postage_readiness" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.production_fulfillment_postage_approved &&
      trimspace(var.production_fulfillment_postage_reference) != ""
    )
    error_message = "Production marketplace promotion requires approved Fulfillment postage evidence before live shipment labels."
  }
}

check "production_transactional_email_readiness" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.production_transactional_email_approved &&
      trimspace(var.production_transactional_email_reference) != ""
    )
    error_message = "Production marketplace promotion requires approved transactional email evidence before live marketplace notifications."
  }
}

check "production_launch_supply_measurements_readiness" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.production_launch_supply_measurements_approved &&
      trimspace(var.production_launch_supply_measurements_reference) != ""
    )
    error_message = "Production marketplace promotion requires approved launch supply measurement evidence before public checkout."
  }
}

check "production_tax_readiness" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.production_tax_readiness_approved &&
      trimspace(var.production_tax_readiness_reference) != ""
    )
    error_message = "Production marketplace promotion requires approved Tax readiness evidence before live order creation."
  }
}

resource "digitalocean_database_db" "contexts" {
  for_each   = local.context_databases
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = each.value
}

resource "digitalocean_database_user" "contexts" {
  for_each   = local.context_database_users
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = each.value
}

# Dedicated least-privilege relay listener users (#1243): one per wave-1
# source context in staging and production. The worker-owned wake relay uses
# these for LISTEN only; grants below give CONNECT + schema USAGE + read-only
# event-store SELECT, never DML on domain tables.
resource "digitalocean_database_user" "wake_listeners" {
  for_each   = local.wake_listener_database_users
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = each.value
}

resource "digitalocean_database_connection_pool" "contexts" {
  for_each = local.non_production_connection_pool_contexts

  cluster_id = digitalocean_database_cluster.postgres.id
  name       = "${each.key}-runtime"
  mode       = "transaction"
  size       = local.context_database_connection_pool_sizes[each.key]
  db_name    = digitalocean_database_db.contexts[each.key].name
  user       = digitalocean_database_user.contexts[each.key].name
}

resource "terraform_data" "context_database_grants" {
  triggers_replace = concat(
    [digitalocean_database_cluster.postgres.id],
    [
      for context_name in sort(keys(local.context_databases)) :
      "${digitalocean_database_db.contexts[context_name].id}:${digitalocean_database_user.contexts[context_name].id}"
    ],
  )

  provisioner "local-exec" {
    working_dir = "${path.module}/../../.."
    command     = "node scripts/apply-digitalocean-database-grant.mjs"

    environment = {
      DATABASE_GRANTS_JSON = jsonencode([
        for context_name in sort(keys(local.context_databases)) : {
          database = digitalocean_database_db.contexts[context_name].name
          user     = digitalocean_database_user.contexts[context_name].name
        }
      ])
      PGDATABASE = digitalocean_database_db.contexts[sort(keys(local.context_databases))[0]].name
      PGHOST     = digitalocean_database_cluster.postgres.host
      PGPASSWORD = digitalocean_database_cluster.postgres.password
      PGPORT     = tostring(digitalocean_database_cluster.postgres.port)
      PGSSLMODE  = "require"
      PGUSER     = digitalocean_database_cluster.postgres.user
    }
  }

  depends_on = [
    digitalocean_database_db.contexts,
    digitalocean_database_user.contexts,
  ]
}

# Least-privilege grants for the relay wake-listener users (#1243): CONNECT
# (LISTEN needs nothing more), USAGE on the schema, and SELECT on the
# event-store tables only. Runs inside the same terraform apply as the user
# creation, and digitalocean_app.platform depends on it, so grants always land
# before workers restart with the listener URLs.
resource "terraform_data" "wake_listener_database_grants" {
  count = length(local.wake_listener_grant_contexts) > 0 ? 1 : 0

  triggers_replace = concat(
    [digitalocean_database_cluster.postgres.id],
    [
      for context_name in sort(local.wake_listener_grant_contexts) :
      "${digitalocean_database_db.contexts[context_name].id}:${digitalocean_database_user.wake_listeners[context_name].id}"
    ],
  )

  provisioner "local-exec" {
    working_dir = "${path.module}/../../.."
    command     = "node scripts/apply-digitalocean-database-grant.mjs"

    environment = {
      DATABASE_GRANTS_JSON = jsonencode([
        for context_name in sort(local.wake_listener_grant_contexts) : {
          database = digitalocean_database_db.contexts[context_name].name
          user     = digitalocean_database_user.wake_listeners[context_name].name
          kind     = "wake-listener"
        }
      ])
      PGDATABASE = digitalocean_database_db.contexts[sort(local.wake_listener_grant_contexts)[0]].name
      PGHOST     = digitalocean_database_cluster.postgres.host
      PGPASSWORD = digitalocean_database_cluster.postgres.password
      PGPORT     = tostring(digitalocean_database_cluster.postgres.port)
      PGSSLMODE  = "require"
      PGUSER     = digitalocean_database_cluster.postgres.user
    }
  }

  depends_on = [
    digitalocean_database_db.contexts,
    digitalocean_database_user.wake_listeners,
  ]
}

check "worker_runner_capacity" {
  assert {
    condition = (
      tonumber(local.worker_projection_concurrency) +
      tonumber(local.worker_job_concurrency) +
      tonumber(local.worker_dispatch_concurrency) +
      tonumber(local.worker_scheduled_concurrency) +
      tonumber(local.worker_wake_concurrency)
    ) <= tonumber(local.worker_database_pool_max)
    error_message = "Worker runner concurrency must not exceed worker_database_pool_max. Increase worker_database_pool_max or reduce WORKER_*_MAX_CONCURRENT_RUNNERS."
  }
}

# Push-wake connection budget gate (#1244/#1236): the plan-time budget in
# locals.tf must fit the selected DigitalOcean database tier in steady state
# and during rolling-deploy overlap. Previews are excluded by design: they are
# fallback-first (no listener URLs, no push rollout) and intentionally
# oversubscribe the 1GB tier with lazily opened PgBouncer backends. The
# per-environment ledger and assumptions live in
# docs/architecture/push-wake-connection-budget.md.
check "wake_connection_budget" {
  assert {
    condition = (
      !(local.is_production || local.is_staging) ||
      local.cluster_backend_demand <= local.cluster_connection_limit
    )
    error_message = "Worst-case steady-state backend demand exceeds the budgeted DigitalOcean database tier connection limit. Reduce pool maxima, instance counts, or listener source contexts, or scale database_size, and update docs/architecture/push-wake-connection-budget.md."
  }

  assert {
    condition = (
      !(local.is_production || local.is_staging) ||
      local.cluster_backend_demand_deploy_overlap <= local.cluster_connection_limit
    )
    error_message = "Rolling-deploy overlap backend demand exceeds the budgeted DigitalOcean database tier connection limit. Reduce pool maxima, instance counts, or listener source contexts, or scale database_size before adding push-wake load."
  }
}

# Listener topology parity gate (#1243/#1236): staging and production must
# expose exactly one direct/session-compatible listener URL per wave source
# context and previews must expose none, so relay topology never differs by
# environment shape - only by scale knobs and ramp flags.
check "wake_listener_topology_parity" {
  assert {
    condition = (
      length(local.worker_listener_database_urls) ==
      ((local.is_production || local.is_staging) ? length(local.worker_listener_source_contexts) : 0)
    )
    error_message = "Listener URL topology must define exactly one listener URL per worker_listener_source_contexts entry in staging and production, and none in previews."
  }

  assert {
    condition = (
      !(local.is_production || local.is_staging) ||
      alltrue([
        for context_name in local.worker_listener_source_contexts :
        contains(keys(local.worker_listener_database_urls), context_name)
      ])
    )
    error_message = "Every worker_listener_source_contexts entry must have a matching listener URL key in staging and production so relay source enablement cannot drift between environments."
  }
}

# Listener least-privilege gate (#1243): relay listener URLs must embed the
# dedicated <context>_wake_listener users (CONNECT + read-only event-store
# grants), never the owning context users or App Platform bindings, so a
# regression to full-DML listener credentials fails the plan.
check "wake_listener_least_privilege" {
  assert {
    # lookup() keeps both operands evaluable in previews (no listener URLs):
    # HCL logical operators do not short-circuit evaluation.
    condition = (
      !(local.is_production || local.is_staging) ||
      alltrue([
        for context_name in local.worker_listener_source_contexts :
        strcontains(
          lookup(local.worker_listener_database_urls, context_name, ""),
          "//${urlencode(lookup(local.wake_listener_database_users, context_name, "missing-wake-listener-user"))}:",
        )
      ])
    )
    error_message = "Relay listener URLs must use the dedicated wake-listener database users (LISTEN + read-only event-store access), never the owning context users or App Platform bindings."
  }
}

resource "digitalocean_app" "platform" {
  spec {
    name   = "${local.name_prefix}-platform"
    region = var.app_region

    dynamic "domain" {
      for_each = local.public_domains
      content {
        name = domain.value
        type = domain.value == local.app_primary_domain ? "PRIMARY" : "ALIAS"
        zone = local.app_domain_zones[domain.value]
      }
    }

    dynamic "domain" {
      for_each = keys(local.legacy_domain_redirects)
      content {
        name = domain.value
        type = "ALIAS"
        zone = local.app_domain_zones[domain.value]
      }
    }

    dynamic "domain" {
      for_each = local.marketplace_domains
      content {
        name = domain.value
        type = "ALIAS"
        zone = local.app_domain_zones[domain.value]
      }
    }

    dynamic "domain" {
      for_each = local.staging_root_marketplace_domains
      content {
        name = domain.value
        type = domain.value == local.app_primary_domain ? "PRIMARY" : "ALIAS"
        zone = local.app_domain_zones[domain.value]
      }
    }

    domain {
      name = local.admin_domain
      type = "ALIAS"
      zone = local.app_domain_zones[local.admin_domain]
    }

    alert {
      rule = "DEPLOYMENT_FAILED"
      dynamic "destinations" {
        for_each = length(var.alert_emails) > 0 ? [1] : []
        content {
          emails = var.alert_emails
        }
      }
    }

    dynamic "database" {
      for_each = local.is_non_production ? {} : local.context_databases
      content {
        name         = "db-${database.key}"
        engine       = "PG"
        production   = true
        cluster_name = digitalocean_database_cluster.postgres.name
        db_name      = database.value
        db_user      = digitalocean_database_user.contexts[database.key].name
      }
    }

    service {
      name               = "public-web"
      run_command        = "pnpm --filter @chase-sets/app-public-web run start"
      instance_size_slug = var.app_instance_size_slug
      instance_count     = local.public_web_instances
      http_port          = 8080

      image {
        registry_type = "DOCR"
        repository    = var.platform_image_repository
        tag           = var.platform_image_tag

        deploy_on_push {
          enabled = false
        }
      }

      env {
        key   = "NODE_ENV"
        value = "production"
        scope = "RUN_AND_BUILD_TIME"
      }

      dynamic "env" {
        for_each = local.observability_runtime_env
        content {
          key   = env.key
          value = env.value.value
          type  = env.value.secret ? "SECRET" : "GENERAL"
          scope = "RUN_TIME"
        }
      }

      env {
        key   = "PORT"
        value = "8080"
        scope = "RUN_TIME"
      }

      env {
        key   = "DEPLOYMENT_ENVIRONMENT"
        value = var.environment
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_PUBLIC_ORIGIN"
        value = "https://${local.landing_domain}"
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_PUBLIC_INDEXING"
        value = local.is_production ? "true" : "false"
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_DISCORD_INVITE_URL"
        value = var.discord_invite_url
        type  = "SECRET"
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_INTERNAL_API_ORIGIN"
        value = local.api_private_url
        scope = "RUN_TIME"
      }

      health_check {
        http_path = "/"
      }
    }

    dynamic "service" {
      for_each = local.marketplace_web_enabled ? [1] : []
      content {
        name               = "marketplace"
        run_command        = "pnpm --filter @chase-sets/app-marketplace-web run start"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = local.public_web_instances
        http_port          = 8080

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        dynamic "env" {
          for_each = local.observability_runtime_env
          content {
            key   = env.key
            value = env.value.value
            type  = env.value.secret ? "SECRET" : "GENERAL"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PORT"
          value = "8080"
          scope = "RUN_TIME"
        }

        env {
          key   = "DEPLOYMENT_ENVIRONMENT"
          value = var.environment
          scope = "RUN_TIME"
        }

        env {
          key   = "CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE"
          value = var.checkout_shopify_simple_kill_switch_active ? "true" : "false"
          scope = "RUN_TIME"
        }

        env {
          key   = "CHASE_SETS_INTERNAL_API_ORIGIN"
          value = "$${platform-api.PRIVATE_URL}"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_PUBLISHABLE_KEY"
          value = var.stripe_publishable_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "CHASE_SETS_MARKETPLACE_INDEXING"
          value = local.is_production && local.marketplace_public_enabled ? "true" : "false"
          scope = "RUN_TIME"
        }

        env {
          key   = "CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED"
          value = local.production_proof_web_enabled ? "true" : "false"
          scope = "RUN_TIME"
        }

        env {
          key   = "CHASE_SETS_MARKETPLACE_PROOF_ACCESS_PERMISSION"
          value = "security.manage"
          scope = "RUN_TIME"
        }

        health_check {
          http_path = "/health/ready"
        }
      }
    }

    service {
      name               = "admin-web"
      run_command        = "pnpm --filter @chase-sets/app-admin-web run start"
      instance_size_slug = var.app_instance_size_slug
      instance_count     = local.admin_web_instances
      http_port          = 8080

      image {
        registry_type = "DOCR"
        repository    = var.platform_image_repository
        tag           = var.platform_image_tag

        deploy_on_push {
          enabled = false
        }
      }

      env {
        key   = "NODE_ENV"
        value = "production"
        scope = "RUN_AND_BUILD_TIME"
      }

      env {
        key   = "PORT"
        value = "8080"
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_INTERNAL_API_ORIGIN"
        value = local.admin_web_internal_api_origin
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_MARKETPLACE_ORIGIN"
        value = local.marketplace_origin
        scope = "RUN_TIME"
      }

      health_check {
        http_path = "/health/ready"
      }
    }

    dynamic "service" {
      for_each = local.marketplace_platform_enabled ? [1] : []
      content {
        name               = "platform-api"
        run_command        = "pnpm --filter @chase-sets/app-platform-api run start:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = local.api_instances
        http_port          = 8080

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        dynamic "env" {
          for_each = local.observability_runtime_env
          content {
            key   = env.key
            value = env.value.value
            type  = env.value.secret ? "SECRET" : "GENERAL"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PORT"
          value = "8080"
          scope = "RUN_TIME"
        }

        env {
          key   = "READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED"
          value = local.read_consistency_wake_before_wait_enabled
          scope = "RUN_TIME"
        }
        env {
          key   = "PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED"
          value = local.event_store_wake_notifications_enabled
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.api_database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PLATFORM_INTERNAL_AUTH_SECRET"
          value = var.platform_internal_auth_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "CHASE_SETS_INTERNAL_API_ORIGIN"
          value = "http://localhost:8080"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_SECRET_KEY"
          value = var.stripe_secret_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_PUBLISHABLE_KEY"
          value = var.stripe_publishable_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_WEBHOOK_SECRET"
          value = var.stripe_webhook_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_CONNECT_WEBHOOK_SECRET"
          value = var.stripe_connect_webhook_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_API_BASE_URL"
          value = var.stripe_api_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_API_KEY"
          value = var.easypost_api_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_API_BASE_URL"
          value = var.easypost_api_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_WEBHOOK_SECRET"
          value = var.easypost_webhook_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_MODE"
          value = var.easypost_mode
          scope = "RUN_TIME"
        }

        env {
          key   = "GOOGLE_SOCIAL_LOGIN_CLIENT_ID"
          value = var.google_social_login_client_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET"
          value = var.google_social_login_client_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS"
          value = var.admin_google_workspace_hosted_domains
          scope = "RUN_TIME"
        }

        env {
          key   = "FACEBOOK_SOCIAL_LOGIN_CLIENT_ID"
          value = var.facebook_social_login_client_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET"
          value = var.facebook_social_login_client_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "REALTIME_STREAM_LIMITER"
          value = local.realtime_stream_limiter
          scope = "RUN_TIME"
        }

        env {
          key   = "REALTIME_BACKGROUND_MAINTENANCE_ENABLED"
          value = local.is_non_production ? "false" : "true"
          scope = "RUN_TIME"
        }

        env {
          key   = "REALTIME_WAKE_SIGNAL_ENABLED"
          value = local.is_non_production ? "false" : "true"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_STORAGE_KIND"
          value = "s3"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_BUCKET"
          value = local.catalog_asset_s3_bucket
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_REGION"
          value = var.data_region
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ENDPOINT"
          value = local.catalog_asset_s3_endpoint
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_PUBLIC_BASE_URL"
          value = local.catalog_asset_public_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ACCESS_KEY_ID"
          value = var.spaces_access_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_SECRET_ACCESS_KEY"
          value = var.spaces_secret_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "DEPLOYMENT_ENVIRONMENT"
          value = var.environment
          scope = "RUN_TIME"
        }

        env {
          key   = "TAX_PROVIDER_BACKED_QUOTES_REQUIRED"
          value = tostring(var.tax_provider_backed_quotes_required)
          scope = "RUN_TIME"
        }

        health_check {
          http_path = "/health/ready"
        }
      }
    }

    dynamic "service" {
      for_each = local.marketplace_public_enabled ? [] : [1]
      content {
        name               = "admin-support-api"
        run_command        = "pnpm --filter @chase-sets/app-admin-support-api run start:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = local.api_instances
        http_port          = 8080

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED"
          value = local.event_store_wake_notifications_enabled
          scope = "RUN_TIME"
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        dynamic "env" {
          for_each = local.observability_runtime_env
          content {
            key   = env.key
            value = env.value.value
            type  = env.value.secret ? "SECRET" : "GENERAL"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PORT"
          value = "8080"
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.api_database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PLATFORM_INTERNAL_AUTH_SECRET"
          value = var.platform_internal_auth_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "ADMIN_REGISTRATION_ENABLED"
          value = "false"
          scope = "RUN_TIME"
        }

        env {
          key   = "GOOGLE_SOCIAL_LOGIN_CLIENT_ID"
          value = var.google_social_login_client_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET"
          value = var.google_social_login_client_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS"
          value = var.admin_google_workspace_hosted_domains
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_STORAGE_KIND"
          value = "s3"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_BUCKET"
          value = local.catalog_asset_s3_bucket
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_REGION"
          value = var.data_region
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ENDPOINT"
          value = local.catalog_asset_s3_endpoint
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_PUBLIC_BASE_URL"
          value = local.catalog_asset_public_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ACCESS_KEY_ID"
          value = var.spaces_access_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_SECRET_ACCESS_KEY"
          value = var.spaces_secret_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "DEPLOYMENT_ENVIRONMENT"
          value = var.environment
          scope = "RUN_TIME"
        }

        health_check {
          http_path = "/health/ready"
        }
      }
    }

    dynamic "worker" {
      for_each = local.marketplace_platform_enabled ? [1] : []
      content {
        name               = "platform-worker"
        run_command        = "pnpm --filter @chase-sets/app-platform-worker run start:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = local.worker_instances

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        dynamic "env" {
          for_each = local.observability_runtime_env
          content {
            key   = env.key
            value = env.value.value
            type  = env.value.secret ? "SECRET" : "GENERAL"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "CHASE_SETS_MARKETPLACE_INDEXING"
          value = local.is_production && local.marketplace_public_enabled ? "true" : "false"
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.worker_database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "WORKER_MAX_CONCURRENT_RUNNERS"
          value = local.worker_max_concurrent_runners
          scope = "RUN_TIME"
        }

        env {
          key   = "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS"
          value = local.worker_projection_concurrency
          scope = "RUN_TIME"
        }

        env {
          key   = "WORKER_JOB_MAX_CONCURRENT_RUNNERS"
          value = local.worker_job_concurrency
          scope = "RUN_TIME"
        }

        env {
          key   = "WORKER_WAKE_MAX_CONCURRENT_RUNNERS"
          value = local.worker_wake_concurrency
          scope = "RUN_TIME"
        }
        env {
          key   = "WORKER_WAKE_HOT_LANE_RUNNER_COUNT"
          value = local.worker_wake_hot_lane_runners
          scope = "RUN_TIME"
        }
        env {
          key   = "WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT"
          value = local.worker_wake_standard_lane_runners
          scope = "RUN_TIME"
        }
        env {
          key   = "WORKER_WAKE_BULK_LANE_RUNNER_COUNT"
          value = local.worker_wake_bulk_lane_runners
          scope = "RUN_TIME"
        }
        env {
          key   = "WORKER_PROJECTION_WAKE_RELAY_ENABLED"
          value = local.worker_projection_wake_relay_enabled
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED"
          value = local.event_store_wake_notifications_enabled
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.worker_listener_database_urls
          content {
            key   = "WORKER_LISTENER_DATABASE_URL_${upper(replace(env.key, "-", "_"))}"
            value = env.value
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "SOURCE_OBSERVATION_BULK_JOB_LANE_COUNT"
          value = local.source_observation_bulk_job_lanes
          scope = "RUN_TIME"
        }

        env {
          key   = "SOURCE_OBSERVATION_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS"
          value = local.source_observation_bulk_workflow_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "SOURCE_OBSERVATION_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB"
          value = local.source_observation_bulk_job_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_AUTHORING_BULK_JOB_LANE_COUNT"
          value = local.catalog_authoring_bulk_job_lanes
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_AUTHORING_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS"
          value = local.catalog_authoring_bulk_workflow_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_AUTHORING_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB"
          value = local.catalog_authoring_bulk_job_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "SOURCE_OBSERVATION_INTEGRATION_JOB_LANE_COUNT"
          value = local.source_observation_integration_job_lanes
          scope = "RUN_TIME"
        }

        env {
          key   = "SOURCE_OBSERVATION_INTEGRATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS"
          value = local.source_observation_integration_workflow_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "SOURCE_OBSERVATION_INTEGRATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB"
          value = local.source_observation_integration_job_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "INVENTORY_IMPORT_BATCH_JOB_LANE_COUNT"
          value = local.inventory_import_batch_job_lanes
          scope = "RUN_TIME"
        }

        env {
          key   = "INVENTORY_IMPORT_BATCH_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS"
          value = local.inventory_import_batch_workflow_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "INVENTORY_IMPORT_BATCH_JOB_MAX_ACTIVE_CLAIMS_PER_JOB"
          value = local.inventory_import_batch_job_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "PRICING_RECOMMENDATION_JOB_LANE_COUNT"
          value = local.pricing_recommendation_job_lanes
          scope = "RUN_TIME"
        }

        env {
          key   = "PRICING_RECOMMENDATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS"
          value = local.pricing_recommendation_workflow_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "PRICING_RECOMMENDATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB"
          value = local.pricing_recommendation_job_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_LANE_COUNT"
          value = local.settlement_payout_reconciliation_job_lanes
          scope = "RUN_TIME"
        }

        env {
          key   = "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS"
          value = local.settlement_payout_reconciliation_workflow_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB"
          value = local.settlement_payout_reconciliation_job_cap
          scope = "RUN_TIME"
        }

        env {
          key   = "WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS"
          value = local.worker_dispatch_concurrency
          scope = "RUN_TIME"
        }

        env {
          key   = "WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS"
          value = local.worker_scheduled_concurrency
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "CATALOG_ASSET_STORAGE_KIND"
          value = "s3"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_BUCKET"
          value = local.catalog_asset_s3_bucket
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_REGION"
          value = var.data_region
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ENDPOINT"
          value = local.catalog_asset_s3_endpoint
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_PUBLIC_BASE_URL"
          value = local.catalog_asset_public_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ACCESS_KEY_ID"
          value = var.spaces_access_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_SECRET_ACCESS_KEY"
          value = var.spaces_secret_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_SECRET_KEY"
          value = var.stripe_secret_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_PUBLISHABLE_KEY"
          value = var.stripe_publishable_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_WEBHOOK_SECRET"
          value = var.stripe_webhook_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_CONNECT_WEBHOOK_SECRET"
          value = var.stripe_connect_webhook_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_API_BASE_URL"
          value = var.stripe_api_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_API_KEY"
          value = var.easypost_api_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_API_BASE_URL"
          value = var.easypost_api_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_MODE"
          value = var.easypost_mode
          scope = "RUN_TIME"
        }

        env {
          key   = "GOOGLE_SOCIAL_LOGIN_CLIENT_ID"
          value = var.google_social_login_client_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET"
          value = var.google_social_login_client_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS"
          value = var.admin_google_workspace_hosted_domains
          scope = "RUN_TIME"
        }

        env {
          key   = "FACEBOOK_SOCIAL_LOGIN_CLIENT_ID"
          value = var.facebook_social_login_client_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET"
          value = var.facebook_social_login_client_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "NOTIFICATION_EMAIL_PROVIDER"
          value = var.notification_email_provider
          scope = "RUN_TIME"
        }

        env {
          key   = "SES_AWS_REGION"
          value = var.ses_aws_region
          scope = "RUN_TIME"
        }

        env {
          key   = "SES_AWS_ACCESS_KEY_ID"
          value = var.ses_aws_access_key_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "SES_AWS_SECRET_ACCESS_KEY"
          value = var.ses_aws_secret_access_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "SES_FROM_EMAIL"
          value = var.ses_from_email
          scope = "RUN_TIME"
        }

        env {
          key   = "SES_CONFIGURATION_SET_NAME"
          value = var.ses_configuration_set_name
          scope = "RUN_TIME"
        }

        env {
          key   = "SES_SOURCE_ARN"
          value = var.ses_source_arn
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "DEPLOYMENT_ENVIRONMENT"
          value = var.environment
          scope = "RUN_TIME"
        }

      }
    }

    dynamic "worker" {
      for_each = local.marketplace_public_enabled ? [] : [1]
      content {
        name               = "admin-support-worker"
        run_command        = "pnpm --filter @chase-sets/app-admin-support-worker run start:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = local.worker_instances

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED"
          value = local.event_store_wake_notifications_enabled
          scope = "RUN_TIME"
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        dynamic "env" {
          for_each = local.observability_runtime_env
          content {
            key   = env.key
            value = env.value.value
            type  = env.value.secret ? "SECRET" : "GENERAL"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.worker_database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "WORKER_MAX_CONCURRENT_RUNNERS"
          value = local.worker_max_concurrent_runners
          scope = "RUN_TIME"
        }

        env {
          key   = "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS"
          value = local.worker_projection_concurrency
          scope = "RUN_TIME"
        }

        env {
          key   = "WORKER_JOB_MAX_CONCURRENT_RUNNERS"
          value = local.worker_job_concurrency
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "CATALOG_ASSET_STORAGE_KIND"
          value = "s3"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_BUCKET"
          value = local.catalog_asset_s3_bucket
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_REGION"
          value = var.data_region
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ENDPOINT"
          value = local.catalog_asset_s3_endpoint
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_PUBLIC_BASE_URL"
          value = local.catalog_asset_public_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ACCESS_KEY_ID"
          value = var.spaces_access_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_SECRET_ACCESS_KEY"
          value = var.spaces_secret_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }
      }
    }

    dynamic "job" {
      for_each = local.marketplace_platform_enabled ? [1] : []
      content {
        name               = "platform-bootstrap"
        kind               = "PRE_DEPLOY"
        run_command        = "pnpm --filter @chase-sets/app-platform-api run bootstrap:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = 1

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }
        env {
          key   = "PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED"
          value = local.event_store_wake_notifications_enabled
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.bootstrap_database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PLATFORM_INTERNAL_AUTH_SECRET"
          value = var.platform_internal_auth_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_EMAIL"
          value = var.platform_admin_email
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_PASSWORD"
          value = var.platform_admin_password
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_DISPLAY_NAME"
          value = var.platform_admin_display_name
          scope = "RUN_TIME"
        }

        env {
          key   = "TAX_PROVIDER_BACKED_QUOTES_REQUIRED"
          value = tostring(var.tax_provider_backed_quotes_required)
          scope = "RUN_TIME"
        }

        env {
          key   = "DEPLOYMENT_ENVIRONMENT"
          value = var.environment
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_STORAGE_KIND"
          value = "s3"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_BUCKET"
          value = local.catalog_asset_s3_bucket
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_REGION"
          value = var.data_region
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ENDPOINT"
          value = local.catalog_asset_s3_endpoint
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_PUBLIC_BASE_URL"
          value = local.catalog_asset_public_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ACCESS_KEY_ID"
          value = var.spaces_access_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_SECRET_ACCESS_KEY"
          value = var.spaces_secret_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }
      }
    }

    # platform-bootstrap owns production marketplace proof/public bootstrapping.
    # admin-support-bootstrap remains only for landing-only production.
    dynamic "job" {
      for_each = local.marketplace_platform_enabled ? [] : [1]
      content {
        name               = "admin-support-bootstrap"
        kind               = "PRE_DEPLOY"
        run_command        = "pnpm --filter @chase-sets/app-admin-support-api run bootstrap:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = 1

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }
        env {
          key   = "PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED"
          value = local.event_store_wake_notifications_enabled
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.bootstrap_database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PLATFORM_INTERNAL_AUTH_SECRET"
          value = var.platform_internal_auth_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_EMAIL"
          value = var.platform_admin_email
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_PASSWORD"
          value = var.platform_admin_password
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_DISPLAY_NAME"
          value = var.platform_admin_display_name
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_STORAGE_KIND"
          value = "s3"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_BUCKET"
          value = local.catalog_asset_s3_bucket
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_REGION"
          value = var.data_region
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ENDPOINT"
          value = local.catalog_asset_s3_endpoint
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_PUBLIC_BASE_URL"
          value = local.catalog_asset_public_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_ACCESS_KEY_ID"
          value = var.spaces_access_id
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "CATALOG_ASSET_S3_SECRET_ACCESS_KEY"
          value = var.spaces_secret_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "DEPLOYMENT_ENVIRONMENT"
          value = var.environment
          scope = "RUN_TIME"
        }
      }
    }

    ingress {
      dynamic "rule" {
        for_each = local.legacy_domain_redirects
        content {
          match {
            authority {
              exact = rule.key
            }
            path {
              prefix = "/"
            }
          }
          redirect {
            authority     = rule.value
            scheme        = "https"
            redirect_code = 302
          }
        }
      }

      dynamic "rule" {
        for_each = local.ucp_ingress_routes
        content {
          match {
            authority {
              exact = rule.value.authority
            }
            path {
              prefix = rule.value.path_prefix
            }
          }
          component {
            name                 = "platform-api"
            preserve_path_prefix = true
          }
        }
      }

      dynamic "rule" {
        for_each = local.provider_webhook_ingress_routes
        content {
          match {
            authority {
              exact = rule.value.authority
            }
            path {
              prefix = rule.value.path_prefix
            }
          }
          component {
            name                 = "platform-api"
            preserve_path_prefix = true
          }
        }
      }

      dynamic "rule" {
        for_each = local.proof_api_ingress_routes
        content {
          match {
            authority {
              exact = rule.value.authority
            }
            path {
              prefix = rule.value.path_prefix
            }
          }
          component {
            name                 = "platform-api"
            preserve_path_prefix = true
          }
        }
      }

      dynamic "rule" {
        for_each = local.proof_admin_api_ingress_routes
        content {
          match {
            authority {
              exact = rule.value.authority
            }
            path {
              prefix = rule.value.path_prefix
            }
          }
          component {
            name                 = "platform-api"
            preserve_path_prefix = true
          }
        }
      }

      dynamic "rule" {
        for_each = local.proof_web_ingress_routes
        content {
          match {
            authority {
              exact = rule.value.authority
            }
            path {
              prefix = rule.value.path_prefix
            }
          }
          component {
            name                 = "marketplace"
            preserve_path_prefix = true
          }
        }
      }

      dynamic "rule" {
        for_each = local.public_domains
        content {
          match {
            authority {
              exact = rule.value
            }
            path {
              prefix = "/api"
            }
          }
          component {
            name                 = local.api_component_name
            preserve_path_prefix = true
          }
        }
      }

      rule {
        match {
          authority {
            exact = local.admin_domain
          }
          path {
            prefix = "/api"
          }
        }
        component {
          name                 = local.api_component_name
          preserve_path_prefix = true
        }
      }

      dynamic "rule" {
        for_each = local.all_marketplace_domains
        content {
          match {
            authority {
              exact = rule.value
            }
            path {
              prefix = "/api"
            }
          }
          component {
            name                 = "platform-api"
            preserve_path_prefix = true
          }
        }
      }

      dynamic "rule" {
        for_each = local.public_domains
        content {
          match {
            authority {
              exact = rule.value
            }
            path {
              prefix = "/"
            }
          }
          component {
            name                 = "public-web"
            preserve_path_prefix = true
          }
        }
      }

      rule {
        match {
          authority {
            exact = local.admin_domain
          }
          path {
            prefix = "/"
          }
        }
        component {
          name                 = "admin-web"
          preserve_path_prefix = true
        }
      }

      dynamic "rule" {
        for_each = local.all_marketplace_domains
        content {
          match {
            authority {
              exact = rule.value
            }
            path {
              prefix = "/"
            }
          }
          component {
            name                 = "marketplace"
            preserve_path_prefix = true
          }
        }
      }
    }
  }

  timeouts {
    create = "90m"
  }

  depends_on = [
    digitalocean_database_db.contexts,
    digitalocean_database_user.contexts,
    digitalocean_database_user.wake_listeners,
    terraform_data.context_database_grants,
    terraform_data.wake_listener_database_grants,
  ]
}

resource "digitalocean_record" "staging_app_alias" {
  for_each = local.staging_app_alias_record_names

  domain = local.environment_zone
  type   = "CNAME"
  name   = each.value
  value  = "${trimsuffix(trimprefix(digitalocean_app.platform.default_ingress, "https://"), "/")}."
  ttl    = 1800
}

resource "digitalocean_uptime_check" "platform" {
  for_each = var.uptime_checks_enabled ? local.uptime_check_targets : {}

  name    = "${local.name_prefix}-${each.key}"
  target  = each.value
  type    = "https"
  regions = var.uptime_check_regions
  enabled = true

  depends_on = [
    digitalocean_app.platform,
    digitalocean_record.staging_app_alias,
  ]
}

resource "digitalocean_uptime_alert" "platform_down" {
  for_each = var.uptime_checks_enabled && length(var.alert_emails) > 0 ? digitalocean_uptime_check.platform : {}

  name     = "${local.name_prefix}-${each.key}-down"
  check_id = each.value.id
  type     = "down_global"
  period   = "2m"

  notifications {
    email = var.alert_emails
  }
}
