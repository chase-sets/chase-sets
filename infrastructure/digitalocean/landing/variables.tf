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

variable "repo" {
  type    = string
  default = "todd-skelton/chase-sets"
}

variable "branch" {
  type        = string
  description = "Git branch used by App Platform."
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
  type    = string
  default = "db-s-1vcpu-1gb"
}

variable "database_node_count" {
  type    = number
  default = 1
}

variable "app_instance_size_slug" {
  type    = string
  default = "apps-s-1vcpu-1gb"
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

variable "alert_emails" {
  type    = list(string)
  default = []
}
