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
  description = "Deployment environment: staging or production."

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
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
  description = "Production database cluster size. Staging uses staging_database_size because it runs the full platform."
}

variable "staging_database_size" {
  type        = string
  default     = "db-s-1vcpu-1gb"
  description = "Staging database cluster size. Staging uses managed Postgres connection pools to fit the full platform on the smallest tier."
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
    condition     = var.environment != "staging" || startswith(var.stripe_secret_key, "sk_test")
    error_message = "stripe_secret_key must be a Stripe test-mode secret key for staging."
  }
}

variable "stripe_publishable_key" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition     = var.environment != "staging" || startswith(var.stripe_publishable_key, "pk_test")
    error_message = "stripe_publishable_key must be a Stripe test-mode publishable key for staging."
  }
}

variable "stripe_webhook_secret" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition     = var.environment != "staging" || trimspace(var.stripe_webhook_secret) != ""
    error_message = "stripe_webhook_secret is required for staging."
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
    condition     = var.environment != "staging" || var.stripe_connect_return_url == "https://marketplace-staging.chasesets.com/account/payouts"
    error_message = "stripe_connect_return_url must be https://marketplace-staging.chasesets.com/account/payouts for staging."
  }
}

variable "stripe_connect_refresh_url" {
  type    = string
  default = ""

  validation {
    condition     = var.environment != "staging" || var.stripe_connect_refresh_url == "https://marketplace-staging.chasesets.com/account/payouts/setup"
    error_message = "stripe_connect_refresh_url must be https://marketplace-staging.chasesets.com/account/payouts/setup for staging."
  }
}

variable "easypost_api_key" {
  type      = string
  sensitive = true
  default   = ""

  validation {
    condition     = var.environment != "staging" || startswith(var.easypost_api_key, "EZTK")
    error_message = "easypost_api_key must be an EasyPost test API key for staging."
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
    condition     = var.environment != "staging" || var.easypost_mode == "test"
    error_message = "easypost_mode must be test for staging."
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

variable "alert_emails" {
  type    = list(string)
  default = []
}
