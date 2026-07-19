variable "digitalocean_token" {
  type      = string
  sensitive = true
}

variable "spaces_access_id" {
  type      = string
  sensitive = true
}

variable "spaces_secret_key" {
  type      = string
  sensitive = true
}

variable "environment" {
  type        = string
  description = "Deployment environment: preview, staging, or production."

  validation {
    condition     = contains(["preview", "staging", "production"], var.environment)
    error_message = "environment must be preview, staging, or production."
  }
}

variable "environment_project_id" {
  type        = string
  default     = ""
  description = "Optional DigitalOcean project ID. When set, assign owned resources to that project; leave empty to skip project assignment without querying the Projects API."
}

variable "production_marketplace_public_enabled" {
  type        = bool
  default     = false
  description = "Compatibility launch-approval gate for public marketplace web/domain routing in production. Public exposure also requires production_runtime_profile = public."

  validation {
    condition     = var.environment == "production" || var.production_marketplace_public_enabled == false
    error_message = "production_marketplace_public_enabled may only be true for production."
  }
}

variable "production_runtime_profile" {
  type        = string
  default     = "landing"
  description = "Production runtime topology profile. Non-production always runs the public profile."

  validation {
    condition     = contains(["landing", "proof", "public"], var.production_runtime_profile)
    error_message = "production_runtime_profile must be landing, proof, or public."
  }

  validation {
    condition     = var.environment == "production" || var.production_runtime_profile == "landing"
    error_message = "production_runtime_profile may only change for production."
  }
}

variable "production_marketplace_promotion_approved" {
  type        = bool
  default     = false
  description = "Explicit launch approval gate that must be true before the production marketplace deployment switch can promote the public marketplace."

  validation {
    condition     = var.environment == "production" || var.production_marketplace_promotion_approved == false
    error_message = "production_marketplace_promotion_approved may only be true for production."
  }
}

variable "production_marketplace_promotion_reference" {
  type        = string
  default     = ""
  description = "Operator-owned launch approval reference for production marketplace promotion, such as a launch review record, approval ticket, or release decision."

  validation {
    condition     = !var.production_marketplace_promotion_approved || trimspace(var.production_marketplace_promotion_reference) != ""
    error_message = "production_marketplace_promotion_reference is required when production_marketplace_promotion_approved is true."
  }
}

variable "production_marketplace_checkout_fee_approved" {
  type        = bool
  default     = false
  description = "Explicit Payments evidence gate that Marketplace Checkout Fee buyer-facing copy, refund language, state-specific disclosures, and provider posture are approved before production marketplace promotion."

  validation {
    condition     = var.environment == "production" || var.production_marketplace_checkout_fee_approved == false
    error_message = "production_marketplace_checkout_fee_approved may only be true for production."
  }
}

variable "production_marketplace_checkout_fee_reference" {
  type        = string
  default     = ""
  description = "Payments-owned evidence reference for approved Marketplace Checkout Fee launch posture, such as a counsel/provider approval ticket or fee-policy launch review record."

  validation {
    condition     = !var.production_marketplace_checkout_fee_approved || trimspace(var.production_marketplace_checkout_fee_reference) != ""
    error_message = "production_marketplace_checkout_fee_reference is required when production_marketplace_checkout_fee_approved is true."
  }
}

variable "production_checkout_launch_evidence_approved" {
  type        = bool
  default     = false
  description = "Explicit Checkout evidence gate that the simplified buy-cart, buy-now, and sell-list checkout flows are freshly proven against the current release before production marketplace promotion."

  validation {
    condition     = var.environment == "production" || var.production_checkout_launch_evidence_approved == false
    error_message = "production_checkout_launch_evidence_approved may only be true for production."
  }
}

variable "production_checkout_launch_evidence_reference" {
  type        = string
  default     = ""
  description = "Checkout-owned evidence reference for approved production checkout launch posture, such as the composite checkout matrix review record."

  validation {
    condition     = !var.production_checkout_launch_evidence_approved || trimspace(var.production_checkout_launch_evidence_reference) != ""
    error_message = "production_checkout_launch_evidence_reference is required when production_checkout_launch_evidence_approved is true."
  }
}

variable "production_stripe_money_operations_approved" {
  type        = bool
  default     = false
  description = "Explicit Payments and Settlement evidence gate that Stripe live checkout, refunds, disputes, Connect onboarding, payouts, webhooks, platform balance funding, Radar/risk, and reconciliation are approved before production marketplace promotion."

  validation {
    condition     = var.environment == "production" || var.production_stripe_money_operations_approved == false
    error_message = "production_stripe_money_operations_approved may only be true for production."
  }
}

variable "production_stripe_money_operations_reference" {
  type        = string
  default     = ""
  description = "Payments and Settlement evidence reference for approved Stripe live money operations readiness, such as a live-mode rehearsal record or Finance/Operations launch review ticket."

  validation {
    condition     = !var.production_stripe_money_operations_approved || trimspace(var.production_stripe_money_operations_reference) != ""
    error_message = "production_stripe_money_operations_reference is required when production_stripe_money_operations_approved is true."
  }
}

variable "production_support_operations_approved" {
  type        = bool
  default     = false
  description = "Explicit Support evidence gate that operator queue review, lifecycle rehearsal, refund visibility, settlement holds, and support notifications are approved before production marketplace promotion."

  validation {
    condition     = var.environment == "production" || var.production_support_operations_approved == false
    error_message = "production_support_operations_approved may only be true for production."
  }
}

variable "production_support_operations_reference" {
  type        = string
  default     = ""
  description = "Support-owned approval reference for production support operations readiness."

  validation {
    condition     = !var.production_support_operations_approved || trimspace(var.production_support_operations_reference) != ""
    error_message = "production_support_operations_reference is required when production_support_operations_approved is true."
  }
}

variable "production_fulfillment_postage_approved" {
  type        = bool
  default     = false
  description = "Explicit Fulfillment evidence gate that production postage provider label purchase, label void/refund, tracking, exceptions, and letter mailpiece handling are approved before production marketplace promotion."

  validation {
    condition     = var.environment == "production" || var.production_fulfillment_postage_approved == false
    error_message = "production_fulfillment_postage_approved may only be true for production."
  }
}

variable "production_fulfillment_postage_reference" {
  type        = string
  default     = ""
  description = "Fulfillment-owned evidence reference for approved production postage provider readiness, such as an EasyPost production rehearsal record or launch review ticket."

  validation {
    condition     = !var.production_fulfillment_postage_approved || trimspace(var.production_fulfillment_postage_reference) != ""
    error_message = "production_fulfillment_postage_reference is required when production_fulfillment_postage_approved is true."
  }
}

variable "production_transactional_email_approved" {
  type        = bool
  default     = false
  description = "Explicit Notifications evidence gate that production transactional email DNS, controlled sends, outbox delivery, bounce/complaint handling, and critical templates are approved before production marketplace promotion."

  validation {
    condition     = var.environment == "production" || var.production_transactional_email_approved == false
    error_message = "production_transactional_email_approved may only be true for production."
  }
}

variable "production_transactional_email_reference" {
  type        = string
  default     = ""
  description = "Notifications-owned evidence reference for approved production transactional email readiness, such as an Amazon SES production rehearsal record or launch review ticket."

  validation {
    condition     = !var.production_transactional_email_approved || trimspace(var.production_transactional_email_reference) != ""
    error_message = "production_transactional_email_reference is required when production_transactional_email_approved is true."
  }
}

variable "production_launch_supply_measurements_approved" {
  type        = bool
  default     = false
  description = "Explicit Catalog and Ordering evidence gate that launch supply has resolved product measurement coverage before public checkout opens."

  validation {
    condition     = var.environment == "production" || var.production_launch_supply_measurements_approved == false
    error_message = "production_launch_supply_measurements_approved may only be true for production."
  }
}

variable "production_launch_supply_measurements_reference" {
  type        = string
  default     = ""
  description = "Catalog-owned evidence reference for approved launch supply measurement coverage, such as a production data-quality sweep record or launch review ticket."

  validation {
    condition     = !var.production_launch_supply_measurements_approved || trimspace(var.production_launch_supply_measurements_reference) != ""
    error_message = "production_launch_supply_measurements_reference is required when production_launch_supply_measurements_approved is true."
  }
}

variable "production_tax_readiness_approved" {
  type        = bool
  default     = false
  description = "Explicit evidence gate that Tax launch readiness has been approved before public production marketplace order creation."

  validation {
    condition     = var.environment == "production" || var.production_tax_readiness_approved == false
    error_message = "production_tax_readiness_approved may only be true for production."
  }
}

variable "production_tax_readiness_reference" {
  type        = string
  default     = ""
  description = "Operator-owned evidence reference for approved production Tax readiness, such as a counsel/accounting ticket or launch review record."

  validation {
    condition     = !var.production_tax_readiness_approved || trimspace(var.production_tax_readiness_reference) != ""
    error_message = "production_tax_readiness_reference is required when production_tax_readiness_approved is true."
  }
}

variable "preview_identifier" {
  type        = string
  default     = ""
  description = "Stable lowercase identifier for a PR preview environment, for example pr-123."

  validation {
    condition = (
      var.environment != "preview" ||
      can(regex("^pr-[0-9]+$", var.preview_identifier))
    )
    error_message = "preview_identifier must be set to a value like pr-123 when environment is preview."
  }
}

variable "data_region" {
  type        = string
  default     = "nyc3"
  description = "DigitalOcean managed Postgres and Spaces region slug."
}

variable "root_domain" {
  type    = string
  default = "chasesets.com"
}

variable "observability_enabled" {
  type        = bool
  default     = true
  description = "Enables OpenTelemetry export for the deployed DOKS runtime when an OTLP endpoint is available."
}

variable "observability_otlp_endpoint" {
  type        = string
  default     = ""
  description = "Optional HTTPS OTLP endpoint override. Staging and production default to the observability stack endpoint for the environment."
}

variable "observability_otlp_headers" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Comma-separated OTLP HTTP write headers, for example x-chase-sets-observability-token=<token>. Required for staging and production telemetry export."
}

variable "postgres_version" {
  type        = string
  default     = "16"
  description = "Latest supported Postgres version that supports required extensions; keep 16 as the known local-compatible fallback."
}

variable "database_size" {
  type        = string
  default     = "db-s-2vcpu-4gb"
  description = "Production database cluster size. Keep enough connection and CPU headroom for the deployed component pool budgets."
}

variable "staging_database_size" {
  type        = string
  default     = "db-s-2vcpu-4gb"
  description = "Staging database cluster size. Staging needs enough server connection capacity for the full-platform managed PgBouncer pool shape."
}

variable "staging_database_storage_size_mib" {
  type        = number
  default     = 61440
  description = "Create-time storage allocation for the staging managed Postgres cluster. Existing clusters ignore drift so the plan-minimum allocation activates only when staging reset recreates Postgres."

  validation {
    condition     = var.staging_database_storage_size_mib >= 61440
    error_message = "staging_database_storage_size_mib must be at least 61440 MiB."
  }
}

variable "database_node_count" {
  type        = number
  default     = 1
  description = "Managed Postgres node count. Production must stay at 1 until production_database_standby_approved and production_database_standby_reference record explicit launch/cost approval plus a support-safe no-delete/no-replace plan."

  validation {
    condition     = var.database_node_count >= 1 && var.database_node_count <= 3
    error_message = "database_node_count must be between 1 and 3."
  }
}

variable "production_database_standby_approved" {
  type        = bool
  default     = false
  description = "Explicit production HA/cost approval gate required before database_node_count may exceed 1 in production."

  validation {
    condition     = var.environment == "production" || var.production_database_standby_approved == false
    error_message = "production_database_standby_approved may only be true for production."
  }
}

variable "production_database_standby_reference" {
  type        = string
  default     = ""
  description = "Operator-owned approval and plan-evidence reference for adding a production managed-Postgres standby node."

  validation {
    condition     = !var.production_database_standby_approved || trimspace(var.production_database_standby_reference) != ""
    error_message = "production_database_standby_reference is required when production_database_standby_approved is true."
  }
}

variable "managed_postgres_alerts_enabled" {
  type        = bool
  default     = true
  description = "Create DigitalOcean DBAAS monitor alerts for provider-exposed managed Postgres cluster health metrics when alert_emails is configured."
}

variable "notification_email_provider" {
  type    = string
  default = "noop"

  validation {
    condition     = contains(["noop", "amazon-ses"], var.notification_email_provider)
    error_message = "notification_email_provider must be noop or amazon-ses."
  }
}

variable "ses_aws_region" {
  type    = string
  default = ""
}

variable "ses_aws_access_key_id" {
  type      = string
  sensitive = true
  default   = ""
}

variable "ses_aws_secret_access_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "ses_from_email" {
  type    = string
  default = ""
}

variable "ses_configuration_set_name" {
  type    = string
  default = ""
}

variable "ses_source_arn" {
  type      = string
  sensitive = true
  default   = ""
}

variable "alert_emails" {
  type        = list(string)
  default     = []
  description = "Email recipients for managed-Postgres and uptime alerts."
}

variable "doks_ingress_target" {
  type        = string
  default     = ""
  description = "Environment-specific live DOKS ingress load balancer IPv4 address."

  validation {
    condition     = trimspace(var.doks_ingress_target) == "" || can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", trimspace(var.doks_ingress_target)))
    error_message = "doks_ingress_target must be a valid IPv4 address when set."
  }
}

variable "doks_ingress_ttl" {
  type        = number
  default     = 300
  description = "TTL for live DOKS ingress DNS records."

  validation {
    condition     = var.doks_ingress_ttl >= 60 && var.doks_ingress_ttl <= 3600
    error_message = "doks_ingress_ttl must be between 60 and 3600 seconds."
  }
}

variable "uptime_checks_enabled" {
  type        = bool
  default     = true
  description = "Create DigitalOcean uptime checks for public platform endpoints."
}

variable "uptime_check_regions" {
  type        = list(string)
  default     = ["us_east", "us_west", "eu_west"]
  description = "DigitalOcean uptime check regions."

  validation {
    condition     = length(var.uptime_check_regions) > 0
    error_message = "uptime_check_regions must include at least one region."
  }
}
