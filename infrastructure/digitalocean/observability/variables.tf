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

variable "stack_environment" {
  type        = string
  default     = "shared"
  description = "Environment label for the consolidated observability host's own self-scrape and file-ingested host logs."

  validation {
    condition     = var.stack_environment == "shared"
    error_message = "The pre-launch observability root provisions only the shared stack."
  }
}

variable "root_domain" {
  type    = string
  default = "chasesets.com"
}

variable "region" {
  type        = string
  default     = "nyc3"
  description = "DigitalOcean region for the observability Droplet and block volume."
}

variable "droplet_size" {
  type        = string
  default     = "s-2vcpu-4gb"
  description = "Droplet size for the single-node observability stack."
}

variable "droplet_image" {
  type        = string
  default     = "ubuntu-24-04-x64"
  description = "Base image used for the observability host."
}

variable "droplet_backups_enabled" {
  type        = bool
  default     = false
  description = "Whether DigitalOcean Droplet backups are enabled for the reproducible observability host. Keep false; use a manual volume snapshot before risky telemetry maintenance instead of recurring host-image backups."

  validation {
    condition     = !var.droplet_backups_enabled
    error_message = "The consolidated pre-launch observability stack keeps DigitalOcean Droplet backups disabled."
  }
}

variable "observability_environments" {
  type        = set(string)
  default     = ["staging", "production"]
  description = "Long-lived environments served by the consolidated observability stack."

  validation {
    condition     = length(var.observability_environments) == 2 && length(setsubtract(var.observability_environments, toset(["staging", "production"]))) == 0 && length(setsubtract(toset(["staging", "production"]), var.observability_environments)) == 0
    error_message = "The consolidated observability stack must serve exactly staging and production."
  }
}

variable "ssh_key_fingerprints" {
  type        = list(string)
  default     = []
  description = "Optional DigitalOcean SSH key fingerprints or IDs authorized on the Droplet."
}

variable "ssh_source_addresses" {
  type        = list(string)
  default     = []
  description = "Optional CIDR ranges allowed to reach SSH. Empty disables public SSH ingress."
}

variable "volume_size_gib" {
  type        = number
  default     = 50
  description = "Persistent block volume size for Prometheus, Loki, Tempo, Grafana, and Caddy data."

  validation {
    condition     = var.volume_size_gib >= 50
    error_message = "volume_size_gib must be at least 50 GiB for the shared pre-launch observability data surface."
  }
}

variable "acceptable_telemetry_data_loss_window_hours" {
  type        = number
  default     = 24
  description = "Maximum accepted telemetry data loss window for this self-hosted observability environment. This is an explicit posture record; it does not create backups by itself."

  validation {
    condition     = var.acceptable_telemetry_data_loss_window_hours > 0 && var.acceptable_telemetry_data_loss_window_hours <= 24
    error_message = "acceptable_telemetry_data_loss_window_hours must be greater than 0 and no more than 24 hours."
  }
}

variable "grafana_admin_user" {
  type        = string
  default     = "chase-sets-admin"
  description = "Initial Grafana admin username. Rotate through Grafana after first login."
}

variable "grafana_admin_password" {
  type        = string
  sensitive   = true
  description = "Initial Grafana admin password."
}

variable "alert_emails" {
  type        = list(string)
  default     = []
  description = "Email recipients for the shared Grafana alert contact point. Use the same operator-owned recipients as PLATFORM_ALERT_EMAILS."

  validation {
    condition     = alltrue([for email in var.alert_emails : can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", email))])
    error_message = "alert_emails entries must be email addresses."
  }
}

variable "grafana_smtp_enabled" {
  type        = bool
  default     = true
  description = "Enables Grafana delivery through the internal SES SendEmail relay. Keep enabled for the shared stack."

  validation {
    condition     = var.grafana_smtp_enabled
    error_message = "The shared observability stack requires Grafana alert delivery."
  }
}

variable "ses_aws_region" {
  type        = string
  default     = "us-east-2"
  description = "AWS region used by the internal SES SendEmail relay."
}

variable "ses_aws_access_key_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Access key for the existing least-privilege SES SendEmail identity."
}

variable "ses_aws_secret_access_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Secret key for the existing least-privilege SES SendEmail identity."
}

variable "ses_configuration_set_name" {
  type        = string
  default     = ""
  description = "Existing SES configuration set required by the alert sender policy."
}

variable "ses_source_arn" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Existing verified SES identity ARN required by the alert sender policy."
}

variable "grafana_smtp_from_address" {
  type        = string
  default     = "notifications@chasesets.com"
  description = "Verified sender address for Grafana alerts."
}

variable "otel_write_token" {
  type        = string
  sensitive   = true
  description = "Header token required by the public OTLP HTTP endpoint."
}

variable "prometheus_query_token" {
  type        = string
  sensitive   = true
  description = "Header token required by the public Prometheus query endpoint used by release automation."
}

variable "acme_email" {
  type        = string
  default     = "ops@chasesets.com"
  description = "Email address Caddy uses for ACME certificate registration."
}

variable "caddy_image" {
  type    = string
  default = "caddy:2.9.1"
}

variable "grafana_image" {
  type    = string
  default = "grafana/grafana:11.4.0"
}

variable "prometheus_image" {
  type    = string
  default = "prom/prometheus:v2.55.1"
}

variable "loki_image" {
  type    = string
  default = "grafana/loki:3.3.0"
}

variable "tempo_image" {
  type    = string
  default = "grafana/tempo:2.6.1"
}

variable "otel_collector_image" {
  type    = string
  default = "otel/opentelemetry-collector-contrib:0.114.0"
}

variable "prometheus_retention" {
  type        = string
  default     = "14d"
  description = "Prometheus TSDB retention window for the shared pre-launch stack. Increase only when incident-response evidence needs it."

  validation {
    condition     = can(regex("^[0-9]+[hd]$", var.prometheus_retention))
    error_message = "prometheus_retention must be a duration such as 24h, 7d, or 30d."
  }
}
