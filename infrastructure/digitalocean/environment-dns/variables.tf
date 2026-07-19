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
  description = "Environment DNS namespace to manage."

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment-dns manages staging or production DNS only."
  }
}

variable "environment_project_id" {
  type        = string
  default     = ""
  description = "Optional DigitalOcean project ID. When set for staging, assign the delegated DNS zone to that project; production's existing root zone stays owned by the platform root."
}

variable "root_domain" {
  type    = string
  default = "chasesets.com"
}

variable "data_region" {
  type        = string
  default     = "nyc3"
  description = "DigitalOcean Spaces/CDN region slug."
}

variable "google_workspace_dkim_txt_value" {
  type        = string
  default     = ""
  description = "Optional Google Workspace DKIM TXT value for google._domainkey.<environment>.<root_domain>."
}

variable "production_marketplace_public_enabled" {
  type        = bool
  default     = false
  description = "Read-only production exposure posture used only to decide whether the marketplace diagnostic hostname is applicable."

  validation {
    condition     = var.environment == "production" || var.production_marketplace_public_enabled == false
    error_message = "production_marketplace_public_enabled may only be true for production."
  }
}

variable "doks_ingress_target" {
  type        = string
  default     = ""
  description = "Environment-specific DOKS ingress load balancer IPv4 address used by retained diagnostic records."

  validation {
    condition     = trimspace(var.doks_ingress_target) == "" || can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", trimspace(var.doks_ingress_target)))
    error_message = "doks_ingress_target must be a valid IPv4 address when set."
  }
}

variable "doks_ingress_ttl" {
  type        = number
  default     = 300
  description = "TTL for retained DOKS diagnostic DNS records."

  validation {
    condition     = var.doks_ingress_ttl >= 60 && var.doks_ingress_ttl <= 3600
    error_message = "doks_ingress_ttl must be between 60 and 3600 seconds."
  }
}
