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

variable "doks_ingress_dns_enabled" {
  type        = bool
  default     = false
  description = "When true, point staging app host records at the DOKS ingress target instead of leaving App Platform as the DNS owner."
}

variable "doks_ingress_target" {
  type        = string
  default     = ""
  description = "DOKS ingress load balancer IPv4 address. Required when doks_ingress_dns_enabled is true."
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
