moved {
  from = digitalocean_database_cluster.postgres
  to   = digitalocean_database_cluster.postgres[0]
}

moved {
  from = terraform_data.context_database_grants
  to   = terraform_data.context_database_grants[0]
}

resource "digitalocean_database_cluster" "postgres" {
  count = local.managed_postgres_enabled ? 1 : 0

  name             = "${local.name_prefix}-postgres"
  engine           = "pg"
  version          = var.postgres_version
  size             = local.database_size
  region           = var.data_region
  node_count       = var.database_node_count
  storage_size_mib = local.database_storage_size_mib
  tags             = [var.environment, "platform", "managed-by-terraform"]

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [storage_size_mib]
  }
}

check "context_database_name_lengths" {
  assert {
    condition     = alltrue([for database_name in values(local.context_databases) : length(database_name) <= 40])
    error_message = "DigitalOcean context database names must be 40 characters or fewer; add an explicit token override for long bounded-context names."
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

check "production_database_standby_approval" {
  assert {
    condition = var.environment != "production" || var.database_node_count == 1 || (
      var.production_database_standby_approved &&
      length(trimspace(var.production_database_standby_reference)) >= 6 &&
      !contains(local.placeholder_evidence_references, lower(trimspace(var.production_database_standby_reference)))
    )
    error_message = "Production database_node_count may not exceed 1 until explicit HA/cost approval and support-safe no-delete/no-replace plan evidence are recorded in production_database_standby_reference."
  }
}

check "production_marketplace_promotion" {
  assert {
    condition = !var.production_marketplace_public_enabled || (
      var.environment == "production" &&
      var.production_runtime_profile == "public" &&
      var.notification_email_provider == "amazon-ses" &&
      trimspace(var.ses_aws_region) != "" &&
      trimspace(var.ses_aws_access_key_id) != "" &&
      trimspace(var.ses_aws_secret_access_key) != "" &&
      trimspace(var.ses_from_email) != "" &&
      trimspace(var.ses_configuration_set_name) != "" &&
      trimspace(var.ses_source_arn) != ""
    )
    error_message = "Production marketplace promotion requires production public runtime profile and complete Amazon SES transactional email configuration."
  }
}

check "production_runtime_profile_public_gate" {
  assert {
    condition = var.environment != "production" || (
      (var.production_runtime_profile == "public") == var.production_marketplace_public_enabled
    )
    error_message = "Production public runtime profile and production_marketplace_public_enabled must be changed together."
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
    error_message = "Production marketplace promotion requires approved Support readiness before live order support."
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
  for_each   = local.managed_context_databases
  cluster_id = digitalocean_database_cluster.postgres[0].id
  name       = each.value
}

resource "digitalocean_database_user" "contexts" {
  for_each   = local.managed_context_database_users
  cluster_id = digitalocean_database_cluster.postgres[0].id
  name       = each.value
}

# Dedicated least-privilege relay listener users (#1243): one per wave-1
# source context in staging and production. The worker-owned wake relay uses
# these for LISTEN only; grants below give CONNECT + schema USAGE + read-only
# event-store SELECT, never DML on domain tables.
resource "digitalocean_database_user" "wake_listeners" {
  for_each   = local.wake_listener_database_users
  cluster_id = digitalocean_database_cluster.postgres[0].id
  name       = each.value
}

resource "digitalocean_database_connection_pool" "contexts" {
  for_each = local.connection_pool_contexts

  cluster_id = digitalocean_database_cluster.postgres[0].id
  name       = "${each.key}-runtime"
  mode       = "transaction"
  size       = local.context_database_connection_pool_sizes[each.key]
  db_name    = digitalocean_database_db.contexts[each.key].name
  user       = digitalocean_database_user.contexts[each.key].name
}

resource "terraform_data" "context_database_grants" {
  count = local.managed_postgres_enabled ? 1 : 0

  triggers_replace = concat(
    [digitalocean_database_cluster.postgres[0].id],
    [
      for context_name in sort(keys(local.managed_context_databases)) :
      "${digitalocean_database_db.contexts[context_name].id}:${digitalocean_database_user.contexts[context_name].id}"
    ],
  )

  provisioner "local-exec" {
    working_dir = "${path.module}/../../.."
    command     = "node scripts/apply-digitalocean-database-grant.mjs"

    environment = {
      DATABASE_GRANTS_JSON = jsonencode([
        for context_name in sort(keys(local.managed_context_databases)) : {
          database = digitalocean_database_db.contexts[context_name].name
          user     = digitalocean_database_user.contexts[context_name].name
        }
      ])
      PGDATABASE = digitalocean_database_db.contexts[sort(keys(local.managed_context_databases))[0]].name
      PGHOST     = digitalocean_database_cluster.postgres[0].host
      PGPASSWORD = digitalocean_database_cluster.postgres[0].password
      PGPORT     = tostring(digitalocean_database_cluster.postgres[0].port)
      PGSSLMODE  = "require"
      PGUSER     = digitalocean_database_cluster.postgres[0].user
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
# creation, so grants land before DOKS workers restart with the listener URLs.
resource "terraform_data" "wake_listener_database_grants" {
  count = length(local.wake_listener_grant_contexts) > 0 ? 1 : 0

  triggers_replace = concat(
    [digitalocean_database_cluster.postgres[0].id],
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
      PGHOST     = digitalocean_database_cluster.postgres[0].host
      PGPASSWORD = digitalocean_database_cluster.postgres[0].password
      PGPORT     = tostring(digitalocean_database_cluster.postgres[0].port)
      PGSSLMODE  = "require"
      PGUSER     = digitalocean_database_cluster.postgres[0].user
    }
  }

  depends_on = [
    digitalocean_database_db.contexts,
    digitalocean_database_user.wake_listeners,
  ]
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
# grants), never the owning context users, so a
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
    error_message = "Relay listener URLs must use the dedicated wake-listener database users (LISTEN + read-only event-store access), never the owning context users."
  }
}

resource "digitalocean_uptime_check" "platform" {
  for_each = var.uptime_checks_enabled ? local.uptime_check_targets : {}

  name    = "${local.name_prefix}-${each.key}"
  target  = each.value
  type    = "https"
  regions = var.uptime_check_regions
  enabled = true

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

resource "digitalocean_monitor_alert" "managed_postgres" {
  for_each = local.managed_postgres_enabled && var.managed_postgres_alerts_enabled && length(var.alert_emails) > 0 ? local.managed_postgres_alert_policies : {}

  description = each.value.description
  type        = each.value.type
  compare     = each.value.compare
  value       = each.value.value
  window      = each.value.window
  enabled     = true
  entities    = [digitalocean_database_cluster.postgres[0].id]

  alerts {
    email = var.alert_emails
  }
}
