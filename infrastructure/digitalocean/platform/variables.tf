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
  type    = string
  default = "nyc3"
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
  default     = "db-s-1vcpu-1gb"
  description = "Production database cluster size. Non-production uses non_production_database_size because it runs the full platform."
}

variable "non_production_database_size" {
  type        = string
  default     = "db-s-1vcpu-1gb"
  description = "Preview and staging database cluster size. Non-production uses managed Postgres connection pools to fit the full platform on the smallest tier."
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
    condition     = var.environment == "production" || startswith(var.stripe_secret_key, "sk_test")
    error_message = "stripe_secret_key must be a Stripe test-mode secret key for non-production environments."
  }
}

variable "stripe_publishable_key" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition     = var.environment == "production" || startswith(var.stripe_publishable_key, "pk_test")
    error_message = "stripe_publishable_key must be a Stripe test-mode publishable key for non-production environments."
  }
}

variable "stripe_webhook_secret" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition     = var.environment == "production" || trimspace(var.stripe_webhook_secret) != ""
    error_message = "stripe_webhook_secret is required for non-production environments."
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
      var.environment == "production" ||
      var.stripe_connect_return_url == format(
        "https://marketplace-%s.%s/account/payouts",
        var.environment == "preview" ? var.preview_identifier : var.environment,
        var.root_domain,
      )
    )
    error_message = "stripe_connect_return_url must match the non-production marketplace domain."
  }
}

variable "stripe_connect_refresh_url" {
  type    = string
  default = ""

  validation {
    condition = (
      var.environment == "production" ||
      var.stripe_connect_refresh_url == format(
        "https://marketplace-%s.%s/account/payouts/setup",
        var.environment == "preview" ? var.preview_identifier : var.environment,
        var.root_domain,
      )
    )
    error_message = "stripe_connect_refresh_url must match the non-production marketplace domain."
  }
}

variable "easypost_api_key" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition     = var.environment == "production" || startswith(var.easypost_api_key, "EZTK")
    error_message = "easypost_api_key must be an EasyPost test API key for non-production environments."
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
  type    = list(string)
  default = []
}
