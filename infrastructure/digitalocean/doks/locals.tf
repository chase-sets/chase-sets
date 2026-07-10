locals {
  cluster_name = trimspace(var.cluster_name) == "" ? "${var.name_prefix}-${var.environment}-doks" : var.cluster_name

  default_runtime_node_count = var.environment == "production" ? 2 : 1
  runtime_node_count         = var.runtime_node_pool_node_count == 0 ? local.default_runtime_node_count : var.runtime_node_pool_node_count
  runtime_min_nodes          = var.runtime_node_pool_min_nodes == 0 ? local.runtime_node_count : var.runtime_node_pool_min_nodes
  runtime_max_nodes          = var.runtime_node_pool_max_nodes == 0 ? local.runtime_min_nodes : var.runtime_node_pool_max_nodes

  # The larger runtime pool is a staging migration target. Keeping it outside
  # the cluster's default node_pool block avoids replacing the whole cluster.
  runtime_xl_node_pool_enabled = var.environment == "staging" && var.runtime_xl_node_pool_enabled

  # PR previews run only on the staging cluster, so the dedicated preview
  # node pool never exists in production.
  preview_node_pool_enabled = var.environment == "staging" && var.preview_node_pool_enabled

  preview_node_pool_taint = {
    key    = "chase-sets.com/preview-only"
    value  = "true"
    effect = "NoSchedule"
  }

  base_tags = [
    var.environment,
    "platform",
    "doks",
    "managed-by-terraform",
  ]

  tags = distinct(concat(local.base_tags, var.tags))

  container_registry_server_url = var.manage_container_registry ? digitalocean_container_registry.platform[0].server_url : "registry.digitalocean.com/${var.container_registry_name}"
}
