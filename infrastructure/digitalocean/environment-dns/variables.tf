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
