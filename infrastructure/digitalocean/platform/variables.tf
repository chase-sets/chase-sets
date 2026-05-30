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
  description = "Explicit gate for deploying public marketplace, platform API, worker, and commerce contexts in production. Keep false until marketplace production promotion is approved."

  validation {
    condition     = var.environment == "production" || var.production_marketplace_public_enabled == false
    error_message = "production_marketplace_public_enabled may only be true for production."
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
      !var.production_marketplace_public_enabled || startswith(var.stripe_secret_key, "sk_live")
    ) : startswith(var.stripe_secret_key, "sk_test")
    error_message = "stripe_secret_key must be test-mode outside production and live-mode when production marketplace promotion is enabled."
  }
}

variable "stripe_publishable_key" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = var.environment == "production" ? (
      !var.production_marketplace_public_enabled || startswith(var.stripe_publishable_key, "pk_live")
    ) : startswith(var.stripe_publishable_key, "pk_test")
    error_message = "stripe_publishable_key must be test-mode outside production and live-mode when production marketplace promotion is enabled."
  }
}

variable "stripe_webhook_secret" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition     = (var.environment == "production" && !var.production_marketplace_public_enabled) || trimspace(var.stripe_webhook_secret) != ""
    error_message = "stripe_webhook_secret is required outside gated landing-only production and during production marketplace promotion."
  }
}

variable "stripe_api_base_url" {
  type    = string
  default = ""
}

variable "stripe_connect_return_url" {
  type    = string
  default = ""

  validation {
    condition = (
      (var.environment == "production" && !var.production_marketplace_public_enabled) ||
      var.stripe_connect_return_url == (
        var.environment == "production" ?
        format("https://marketplace.%s/account/payouts", var.root_domain) :
        (var.environment == "preview" ?
          format("https://marketplace.%s.preview.%s/account/payouts", var.preview_identifier, var.root_domain) :
          format("https://marketplace.%s.%s/account/payouts", var.environment, var.root_domain)
        )
      )
    )
    error_message = "stripe_connect_return_url must match the marketplace domain whenever marketplace platform deployment is enabled."
  }
}

variable "stripe_connect_refresh_url" {
  type    = string
  default = ""

  validation {
    condition = (
      (var.environment == "production" && !var.production_marketplace_public_enabled) ||
      var.stripe_connect_refresh_url == (
        var.environment == "production" ?
        format("https://marketplace.%s/account/payouts/setup", var.root_domain) :
        (var.environment == "preview" ?
          format("https://marketplace.%s.preview.%s/account/payouts/setup", var.preview_identifier, var.root_domain) :
          format("https://marketplace.%s.%s/account/payouts/setup", var.environment, var.root_domain)
        )
      )
    )
    error_message = "stripe_connect_refresh_url must match the marketplace domain whenever marketplace platform deployment is enabled."
  }
}

variable "easypost_api_key" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition = var.environment == "production" ? (
      !var.production_marketplace_public_enabled || trimspace(var.easypost_api_key) != ""
    ) : startswith(var.easypost_api_key, "EZTK")
    error_message = "easypost_api_key must be an EasyPost test API key outside production and must be present when production marketplace promotion is enabled."
  }
}

variable "easypost_api_base_url" {
  type    = string
  default = ""
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
    condition     = var.environment != "production" || !var.production_marketplace_public_enabled || var.easypost_mode == "production"
    error_message = "easypost_mode must be production when production marketplace promotion is enabled."
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
