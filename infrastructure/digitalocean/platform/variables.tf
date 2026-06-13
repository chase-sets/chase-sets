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

variable "production_marketplace_public_enabled" {
  type        = bool
  default     = false
  description = "Explicit gate for deploying public marketplace web/domain routing in production. Keep false until marketplace production promotion is approved."

  validation {
    condition     = var.environment == "production" || var.production_marketplace_public_enabled == false
    error_message = "production_marketplace_public_enabled may only be true for production."
  }
}

variable "production_marketplace_proof_enabled" {
  type        = bool
  default     = false
  description = "Explicit gate for deploying production platform-api, platform-worker, and commerce contexts for private provider proof while the public marketplace stays closed."

  validation {
    condition     = var.environment == "production" || var.production_marketplace_proof_enabled == false
    error_message = "production_marketplace_proof_enabled may only be true for production."
  }
}

variable "production_marketplace_proof_reference" {
  type        = string
  default     = ""
  description = "Operator-owned evidence-collection approval reference for private production platform proof mode."

  validation {
    condition     = !var.production_marketplace_proof_enabled || trimspace(var.production_marketplace_proof_reference) != ""
    error_message = "production_marketplace_proof_reference is required when production_marketplace_proof_enabled is true."
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

variable "checkout_shopify_simple_kill_switch_active" {
  type        = bool
  default     = false
  description = "Hard runtime kill switch for Shopify-simple checkout entry. When true, marketplace web redirects Buy Cart and Sell List checkout entry back to cart/list recovery without restoring legacy checkout."
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
  description = "Support-owned evidence reference for approved production support operations readiness, such as a staging rehearsal record or launch review ticket."

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

variable "tax_provider_backed_quotes_required" {
  type        = bool
  default     = false
  description = "Runtime Tax gate. Set true only after Tax nexus tracking shows at least one jurisdiction requires live sales-tax collection and provider-backed quote behavior must fail closed until configured."
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

variable "region" {
  type        = string
  default     = "nyc3"
  description = "Deprecated compatibility variable. Use app_region for App Platform and data_region for managed Postgres and Spaces."
}

variable "app_region" {
  type        = string
  default     = "nyc"
  description = "DigitalOcean App Platform region slug."
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
  description = "Enables OpenTelemetry export for deployed App Platform components when an OTLP endpoint is available."
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

variable "non_production_database_size" {
  type        = string
  default     = "db-s-1vcpu-1gb"
  description = "Preview database cluster size. Staging uses staging_database_size because it runs the shared full-platform environment."
}

variable "staging_database_size" {
  type        = string
  default     = "db-s-2vcpu-4gb"
  description = "Staging database cluster size. Staging needs enough server connection capacity for the full-platform managed PgBouncer pool shape."
}

variable "database_node_count" {
  type    = number
  default = 1
}

variable "app_instance_size_slug" {
  type    = string
  default = "apps-s-1vcpu-1gb"
}

variable "worker_instance_count" {
  type        = number
  default     = 0
  description = "Optional worker instance-count override. Zero uses the environment default: staging runs two workers for handoff capacity; preview and production run one until explicitly scaled."

  validation {
    condition     = var.worker_instance_count >= 0 && var.worker_instance_count <= 10
    error_message = "worker_instance_count must be between 0 and 10. Use 0 to accept the environment default."
  }
}

variable "worker_job_concurrency" {
  type        = number
  default     = 0
  description = "Optional per-worker job runner concurrency override. Zero uses the environment default: staging runs two job runners; preview and production run one until explicitly scaled."

  validation {
    condition     = var.worker_job_concurrency >= 0 && var.worker_job_concurrency <= 10
    error_message = "worker_job_concurrency must be between 0 and 10. Use 0 to accept the environment default."
  }
}

variable "worker_database_pool_max" {
  type        = number
  default     = 0
  description = "Optional per-worker DATABASE_POOL_MAX override. Zero uses the environment default and any positive override must be kept at or above total configured runner concurrency."

  validation {
    condition     = var.worker_database_pool_max >= 0 && var.worker_database_pool_max <= 30
    error_message = "worker_database_pool_max must be between 0 and 30. Use 0 to accept the environment default."
  }
}

variable "platform_image_repository" {
  type        = string
  default     = "chase-sets-platform"
  description = "DigitalOcean Container Registry repository that stores the prebuilt platform runtime image."
}

variable "platform_image_tag" {
  type        = string
  description = "Container image tag to deploy for App Platform components."
}

variable "platform_internal_auth_secret" {
  type      = string
  sensitive = true
}

variable "platform_admin_email" {
  type      = string
  sensitive = true
}

variable "platform_admin_password" {
  type      = string
  sensitive = true
}

variable "platform_admin_display_name" {
  type    = string
  default = "Platform Admin"
}

variable "discord_invite_url" {
  type      = string
  sensitive = true
  default   = ""
}

variable "stripe_secret_key" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = var.environment == "production" ? (
      !(var.production_marketplace_public_enabled || var.production_marketplace_proof_enabled) ||
      startswith(var.stripe_secret_key, "sk_live")
    ) : startswith(var.stripe_secret_key, "sk_test")
    error_message = "stripe_secret_key must be test-mode outside production and live-mode when production marketplace proof or promotion is enabled."
  }
}

variable "stripe_publishable_key" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = var.environment == "production" ? (
      !(var.production_marketplace_public_enabled || var.production_marketplace_proof_enabled) ||
      startswith(var.stripe_publishable_key, "pk_live")
    ) : startswith(var.stripe_publishable_key, "pk_test")
    error_message = "stripe_publishable_key must be test-mode outside production and live-mode when production marketplace proof or promotion is enabled."
  }
}

variable "stripe_webhook_secret" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = (
      (var.environment == "production" && !(var.production_marketplace_public_enabled || var.production_marketplace_proof_enabled)) ||
      trimspace(var.stripe_webhook_secret) != ""
    )
    error_message = "stripe_webhook_secret is required outside gated landing-only production and during production marketplace proof or promotion."
  }
}

variable "stripe_connect_webhook_secret" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = (
      (var.environment == "production" && !(var.production_marketplace_public_enabled || var.production_marketplace_proof_enabled)) ||
      trimspace(var.stripe_connect_webhook_secret) != ""
    )
    error_message = "stripe_connect_webhook_secret is required outside gated landing-only production and during production marketplace proof or promotion."
  }
}

variable "stripe_api_base_url" {
  type    = string
  default = ""
}

variable "easypost_api_key" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = var.environment == "production" ? (
      !(var.production_marketplace_public_enabled || var.production_marketplace_proof_enabled) ||
      trimspace(var.easypost_api_key) != ""
    ) : startswith(var.easypost_api_key, "EZTK")
    error_message = "easypost_api_key must be an EasyPost test API key outside production and must be present when production marketplace proof or promotion is enabled."
  }
}

variable "easypost_api_base_url" {
  type    = string
  default = ""
}

variable "easypost_webhook_secret" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = var.environment == "production" ? (
      !(var.production_marketplace_public_enabled || var.production_marketplace_proof_enabled) ||
      trimspace(var.easypost_webhook_secret) != ""
    ) : true
    error_message = "easypost_webhook_secret is required when production marketplace proof or promotion is enabled."
  }
}

variable "easypost_mode" {
  type    = string
  default = "test"

  validation {
    condition     = contains(["test", "production"], var.easypost_mode)
    error_message = "easypost_mode must be test or production."
  }

  validation {
    condition     = var.environment == "production" || var.easypost_mode == "test"
    error_message = "easypost_mode must be test for non-production environments."
  }

  validation {
    condition = (
      var.environment != "production" ||
      !(var.production_marketplace_public_enabled || var.production_marketplace_proof_enabled) ||
      var.easypost_mode == "production"
    )
    error_message = "easypost_mode must be production when production marketplace proof or promotion is enabled."
  }
}

variable "google_social_login_client_id" {
  type      = string
  sensitive = true
  default   = ""
}

variable "google_social_login_client_secret" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition     = (trimspace(var.google_social_login_client_id) == "") == (trimspace(var.google_social_login_client_secret) == "")
    error_message = "google_social_login_client_id and google_social_login_client_secret must be configured together."
  }
}

variable "admin_google_workspace_hosted_domains" {
  type    = string
  default = ""

  validation {
    condition     = trimspace(var.admin_google_workspace_hosted_domains) == "" || trimspace(var.google_social_login_client_id) != ""
    error_message = "admin_google_workspace_hosted_domains requires google_social_login_client_id."
  }
}

variable "facebook_social_login_client_id" {
  type      = string
  sensitive = true
  default   = ""
}

variable "facebook_social_login_client_secret" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition     = (trimspace(var.facebook_social_login_client_id) == "") == (trimspace(var.facebook_social_login_client_secret) == "")
    error_message = "facebook_social_login_client_id and facebook_social_login_client_secret must be configured together."
  }
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
  description = "Email recipients for App Platform deployment alerts and uptime alerts."
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
