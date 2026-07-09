variable "digitalocean_token" {
  type      = string
  sensitive = true
}

variable "environment" {
  type        = string
  description = "Long-lived DOKS environment to provision."

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "DOKS foundation currently provisions only staging or production."
  }
}

variable "name_prefix" {
  type        = string
  default     = "chase-sets"
  description = "Prefix used for DOKS foundation resources."
}

variable "cluster_name" {
  type        = string
  default     = ""
  description = "Optional explicit cluster name. Empty uses <name_prefix>-<environment>-doks."
}

variable "region" {
  type        = string
  default     = "nyc3"
  description = "DigitalOcean region for the DOKS cluster and node pools."
}

variable "kubernetes_version" {
  type        = string
  description = "Supported DigitalOcean Kubernetes version slug, for example 1.33.1-do.4. Keep this explicit so live applies choose a currently supported DOKS version."

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+-do\\.[0-9]+$", var.kubernetes_version))
    error_message = "kubernetes_version must be a DigitalOcean DOKS version slug like 1.33.1-do.4."
  }
}

variable "auto_upgrade" {
  type        = bool
  default     = true
  description = "Enable DigitalOcean patch auto-upgrades during the configured maintenance window."
}

variable "surge_upgrade" {
  type        = bool
  default     = true
  description = "Enable surge upgrades so node replacement can preserve capacity during cluster upgrades."
}

variable "high_availability" {
  type        = bool
  default     = false
  description = "Enable DOKS high-availability control plane. Keep false until live cost and launch-readiness evidence justify it."
}

variable "vpc_uuid" {
  type        = string
  default     = ""
  description = "Optional DigitalOcean VPC UUID for the cluster. Empty uses the account default VPC in the selected region."
}

variable "cluster_subnet" {
  type        = string
  default     = ""
  description = "Optional pod CIDR for the DOKS cluster overlay network."
}

variable "service_subnet" {
  type        = string
  default     = ""
  description = "Optional service CIDR for the DOKS cluster."
}

variable "maintenance_day" {
  type        = string
  default     = "sunday"
  description = "DOKS maintenance window day."
}

variable "maintenance_start_time" {
  type        = string
  default     = "09:00"
  description = "DOKS maintenance window start time in UTC, HH:MM."

  validation {
    condition     = can(regex("^[0-2][0-9]:[0-5][0-9]$", var.maintenance_start_time))
    error_message = "maintenance_start_time must be HH:MM in UTC."
  }
}

variable "runtime_node_pool_size" {
  type        = string
  default     = "s-2vcpu-4gb"
  description = "Droplet size slug for the primary runtime node pool."
}

variable "runtime_node_pool_node_count" {
  type        = number
  default     = 0
  description = "Primary runtime node count. Zero uses the environment default: production starts at 2 nodes, staging starts at 1 node for lower-cost rehearsal."

  validation {
    condition     = var.runtime_node_pool_node_count >= 0 && var.runtime_node_pool_node_count <= 20
    error_message = "runtime_node_pool_node_count must be between 0 and 20. Use 0 to accept the environment default."
  }
}

variable "runtime_node_pool_auto_scale" {
  type        = bool
  default     = false
  description = "Enable autoscaling for the primary runtime node pool."
}

variable "runtime_node_pool_min_nodes" {
  type        = number
  default     = 0
  description = "Minimum nodes when runtime_node_pool_auto_scale is true. Zero uses the resolved runtime node count."
}

variable "runtime_node_pool_max_nodes" {
  type        = number
  default     = 0
  description = "Maximum nodes when runtime_node_pool_auto_scale is true. Zero uses the resolved minimum node count."
}

variable "additional_node_pools" {
  type = map(object({
    size       = string
    node_count = optional(number, 1)
    auto_scale = optional(bool, false)
    min_nodes  = optional(number, 0)
    max_nodes  = optional(number, 0)
    labels     = optional(map(string), {})
    tags       = optional(list(string), [])
    taints = optional(list(object({
      key    = string
      value  = string
      effect = string
    })), [])
  }))
  default     = {}
  description = "Optional additional DOKS node pools. Keep empty until a measured workload needs isolation."

  validation {
    condition = alltrue([
      for _, pool in var.additional_node_pools :
      !pool.auto_scale || (pool.min_nodes > 0 && pool.max_nodes >= pool.min_nodes)
    ])
    error_message = "Autoscaled additional node pools must set min_nodes > 0 and max_nodes >= min_nodes."
  }
}

variable "registry_integration_enabled" {
  type        = bool
  default     = true
  description = "Attach the account DigitalOcean Container Registry to the DOKS cluster so pods can pull private DOCR images."
}

variable "manage_container_registry" {
  type        = bool
  default     = false
  description = "Create/manage the account-level DOCR registry in this state. Keep false unless this state owns the shared registry or has imported it."
}

variable "container_registry_name" {
  type        = string
  default     = "chase-sets"
  description = "DigitalOcean account registry name used for runtime images."
}

variable "container_registry_region" {
  type        = string
  default     = "nyc3"
  description = "DigitalOcean region for the account registry when manage_container_registry is true."
}

variable "container_registry_subscription_tier_slug" {
  type        = string
  default     = "basic"
  description = "DOCR subscription tier when manage_container_registry is true."
}

variable "tags" {
  type        = list(string)
  default     = []
  description = "Extra DigitalOcean tags applied to DOKS resources."
}

variable "preview_node_pool_enabled" {
  type        = bool
  default     = true
  description = "Provision the dedicated PR-preview node pool. Applies only to the staging cluster; production never hosts previews."
}

variable "preview_node_pool_size" {
  type        = string
  default     = "s-4vcpu-8gb"
  description = "Droplet size slug for preview nodes, sized so one full preview platform stack (web, admin, api, worker, bootstrap, in-cluster Postgres) fits per node."
}

variable "preview_node_pool_max_nodes" {
  type        = number
  default     = 3
  description = "Maximum preview nodes; bounds concurrent PR preview environments. The pool autoscales to zero when no previews are running."

  validation {
    condition     = var.preview_node_pool_max_nodes >= 1 && var.preview_node_pool_max_nodes <= 10
    error_message = "preview_node_pool_max_nodes must be between 1 and 10."
  }
}
