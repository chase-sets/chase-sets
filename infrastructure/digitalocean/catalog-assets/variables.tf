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
  description = "Catalog asset storage environment: preview, staging, or production."

  validation {
    condition     = contains(["preview", "staging", "production"], var.environment)
    error_message = "environment must be preview, staging, or production."
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

variable "cdn_ttl_seconds" {
  type        = number
  default     = 3600
  description = "Catalog asset CDN cache TTL in seconds."

  validation {
    condition     = var.cdn_ttl_seconds >= 60
    error_message = "cdn_ttl_seconds must be at least 60."
  }
}
