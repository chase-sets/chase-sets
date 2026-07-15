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

variable "m86_developer_portal_ready" {
  type        = bool
  default     = false
  description = "Certification readiness gate for serving the noindex Developer Portal. Public indexing is controlled separately."
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
  description = "Deprecated compatibility variable. PR previews use disposable in-cluster Postgres, and staging uses staging_database_size."
}

variable "staging_database_size" {
  type        = string
  default     = "db-s-2vcpu-4gb"
  description = "Staging database cluster size. Staging needs enough server connection capacity for the full-platform managed PgBouncer pool shape."
}

variable "staging_database_storage_size_mib" {
  type        = number
  default     = 25600
  description = "Create-time storage allocation for the staging managed Postgres cluster. Existing clusters ignore drift so the smaller allocation activates only when staging reset recreates Postgres."

  validation {
    condition     = var.staging_database_storage_size_mib >= 25600
    error_message = "staging_database_storage_size_mib must be at least 25600 MiB."
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

variable "app_instance_size_slug" {
  type    = string
  default = "apps-s-1vcpu-1gb"
}

variable "worker_instance_size_slug" {
  type        = string
  default     = ""
  description = "Optional worker instance-size override. Empty uses the recorded environment default: staging keeps larger workers for wake-drill, representative-import, and deploy-handoff proof windows; other environments inherit app_instance_size_slug."
}

variable "worker_instance_count" {
  type        = number
  default     = 0
  description = "Optional worker instance-count override. Zero uses the recorded environment default: staging keeps two workers through DOKS migration proof; preview and production run one until explicitly scaled."

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
  description = "Human-readable container image tag associated with the App Platform release artifact."
}

variable "platform_image_digest" {
  type        = string
  default     = ""
  description = "Verified container image digest to deploy for App Platform components."

  validation {
    condition     = var.platform_image_digest == "" || can(regex("^sha256:[a-f0-9]{64}$", var.platform_image_digest))
    error_message = "platform_image_digest must be empty or a sha256 digest in the form sha256:<64 lowercase hex characters>."
  }
}

variable "platform_bootstrap_owner" {
  type        = string
  default     = "app-platform"
  description = "Exactly one schema-bootstrap owner. Staging and production workflows pass their explicit environment-scoped contract; when set to \"doks\", App Platform skips bootstrap and omits its worker."

  validation {
    condition     = contains(["app-platform", "doks"], var.platform_bootstrap_owner)
    error_message = "platform_bootstrap_owner must be either \"app-platform\" or \"doks\"."
  }
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
      var.production_runtime_profile == "landing" ||
      startswith(var.stripe_secret_key, "sk_live")
    ) : startswith(var.stripe_secret_key, "sk_test")
    error_message = "stripe_secret_key must be test-mode outside production and live-mode when production platform runtime is proof or public."
  }
}

variable "stripe_publishable_key" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = var.environment == "production" ? (
      var.production_runtime_profile == "landing" ||
      startswith(var.stripe_publishable_key, "pk_live")
    ) : startswith(var.stripe_publishable_key, "pk_test")
    error_message = "stripe_publishable_key must be test-mode outside production and live-mode when production platform runtime is proof or public."
  }
}

variable "stripe_webhook_secret" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = (
      (var.environment == "production" && var.production_runtime_profile == "landing") ||
      trimspace(var.stripe_webhook_secret) != ""
    )
    error_message = "stripe_webhook_secret is required outside gated landing-only production and during production proof/public platform runtime."
  }
}

variable "stripe_connect_webhook_secret" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = (
      (var.environment == "production" && var.production_runtime_profile == "landing") ||
      trimspace(var.stripe_connect_webhook_secret) != ""
    )
    error_message = "stripe_connect_webhook_secret is required outside gated landing-only production and during production proof/public platform runtime."
  }
}

variable "stripe_connect_accounts_api" {
  type        = string
  default     = "v2"
  description = "Stripe Connect Accounts API posture for payout account operations. Use v2 for the current implementation; v1 is the explicit launch compatibility target once implemented."

  validation {
    condition     = contains(["v1", "v2"], var.stripe_connect_accounts_api)
    error_message = "stripe_connect_accounts_api must be v1 or v2."
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
      var.production_runtime_profile == "landing" ||
      trimspace(var.easypost_api_key) != ""
    ) : startswith(var.easypost_api_key, "EZTK")
    error_message = "easypost_api_key must be an EasyPost test API key outside production and must be present when production platform runtime is proof or public."
  }
}

variable "voyage_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional Voyage AI key for Discovery Search Index embedding enrichment. Empty disables enrichment cleanly."
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
      var.production_runtime_profile == "landing" ||
      trimspace(var.easypost_webhook_secret) != ""
    ) : true
    error_message = "easypost_webhook_secret is required when production platform runtime is proof or public."
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
      var.production_runtime_profile == "landing" ||
      var.easypost_mode == "production"
    )
    error_message = "easypost_mode must be production when production platform runtime is proof or public."
  }
}

variable "tcgplayer_automation_tcg_auth_cookie" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Approved TCGplayer automation session cookie for Catalog provider option queries and imports. Keep empty until staging or production provider access is approved."
}

variable "scrydex_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Shared approved Scrydex API key for Catalog provider option queries and imports. Configure once per environment for all Scrydex-backed product lines."

  validation {
    condition     = (trimspace(var.scrydex_api_key) == "") == (trimspace(var.scrydex_team_id) == "")
    error_message = "scrydex_api_key and scrydex_team_id must be configured together."
  }
}

variable "scrydex_team_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Shared approved Scrydex team identifier for Catalog provider option queries and imports. Configure once per environment for all Scrydex-backed product lines."
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

variable "staging_app_serving" {
  type        = string
  default     = "app-platform"
  description = "Which platform serves the live staging apex, marketplace, admin, and www hosts. \"app-platform\" (default) attaches the domains and uses CNAME leaf records; \"doks\" releases the attachments and replaces the same leaf record identities with A records before adding the apex A."

  validation {
    condition     = contains(["app-platform", "doks"], var.staging_app_serving)
    error_message = "staging_app_serving must be either \"app-platform\" or \"doks\"."
  }
}

variable "doks_ingress_target" {
  type        = string
  default     = ""
  description = "DOKS ingress load balancer IPv4 address. Required when staging_app_serving is \"doks\" so the live staging records can replace the App Platform records in the same Terraform graph."

  validation {
    condition     = trimspace(var.doks_ingress_target) == "" || can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", trimspace(var.doks_ingress_target)))
    error_message = "doks_ingress_target must be a valid IPv4 address when set."
  }
}

variable "doks_ingress_ttl" {
  type        = number
  default     = 300
  description = "TTL for live DOKS ingress DNS records during cutover."

  validation {
    condition     = var.doks_ingress_ttl >= 60 && var.doks_ingress_ttl <= 3600
    error_message = "doks_ingress_ttl must be between 60 and 3600 seconds."
  }
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
