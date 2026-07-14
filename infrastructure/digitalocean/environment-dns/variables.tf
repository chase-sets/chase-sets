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
    condition     = var.environment == "staging"
    error_message = "environment-dns currently manages the delegated staging.chasesets.com zone only."
  }
}

variable "environment_project_id" {
  type        = string
  default     = ""
  description = "Optional DigitalOcean project ID override. Leave empty to resolve the environment project by name; offline validation plans supply a synthetic ID to avoid live API reads."
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

variable "staging_app_serving" {
  type        = string
  default     = "app-platform"
  description = "Which platform serves the live staging hosts. The platform root owns the mutually exclusive live records; this value lets environment-dns enforce that a DOKS target is configured and report the active serving mode. Shadow validation hosts do not depend on this switch."

  validation {
    condition     = contains(["app-platform", "doks"], var.staging_app_serving)
    error_message = "staging_app_serving must be either \"app-platform\" or \"doks\"."
  }
}

variable "doks_ingress_target" {
  type        = string
  default     = ""
  description = "DOKS ingress load balancer IPv4 address. When set, shadow validation hosts (doks.<zone>, www.doks.<zone>, ...) resolve to the load balancer so DOKS ingress and cert-manager can be proven before cutover. Required before staging_app_serving flips to \"doks\"."

  validation {
    condition     = trimspace(var.doks_ingress_target) == "" || can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", trimspace(var.doks_ingress_target)))
    error_message = "doks_ingress_target must be a valid IPv4 address when set."
  }
}

variable "doks_ingress_ttl" {
  type        = number
  default     = 300
  description = "TTL for opt-in DOKS ingress DNS records during cutover."

  validation {
    condition     = var.doks_ingress_ttl >= 60 && var.doks_ingress_ttl <= 3600
    error_message = "doks_ingress_ttl must be between 60 and 3600 seconds."
  }
}
