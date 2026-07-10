resource "digitalocean_container_registry" "platform" {
  count = var.manage_container_registry ? 1 : 0

  name                   = var.container_registry_name
  region                 = var.container_registry_region
  subscription_tier_slug = var.container_registry_subscription_tier_slug
}

resource "digitalocean_kubernetes_cluster" "platform" {
  name                             = local.cluster_name
  region                           = var.region
  version                          = var.kubernetes_version
  auto_upgrade                     = var.auto_upgrade
  surge_upgrade                    = var.surge_upgrade
  ha                               = var.high_availability
  registry_integration             = var.registry_integration_enabled
  destroy_all_associated_resources = false
  vpc_uuid                         = trimspace(var.vpc_uuid) == "" ? null : var.vpc_uuid
  cluster_subnet                   = trimspace(var.cluster_subnet) == "" ? null : var.cluster_subnet
  service_subnet                   = trimspace(var.service_subnet) == "" ? null : var.service_subnet
  tags                             = local.tags

  maintenance_policy {
    day        = var.maintenance_day
    start_time = var.maintenance_start_time
  }

  node_pool {
    name       = "runtime"
    size       = var.runtime_node_pool_size
    auto_scale = var.runtime_node_pool_auto_scale
    node_count = var.runtime_node_pool_auto_scale ? null : local.runtime_node_count
    min_nodes  = var.runtime_node_pool_auto_scale ? local.runtime_min_nodes : null
    max_nodes  = var.runtime_node_pool_auto_scale ? local.runtime_max_nodes : null
    labels = {
      "chase-sets.com/pool"        = "runtime"
      "chase-sets.com/environment" = var.environment
    }
    tags = local.tags
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    digitalocean_container_registry.platform,
  ]
}

# Dedicated staging runtime capacity (#4756). This must remain a separate node
# pool resource: changing the default node_pool size above forces replacement
# of the entire DOKS cluster. No taint is applied so platform workloads can
# migrate here without a toleration.
resource "digitalocean_kubernetes_node_pool" "runtime_xl" {
  count = local.runtime_xl_node_pool_enabled ? 1 : 0

  cluster_id = digitalocean_kubernetes_cluster.platform.id
  name       = "runtime-xl"
  size       = var.runtime_xl_node_pool_size
  auto_scale = false
  node_count = 1
  labels = {
    "chase-sets.com/pool"        = "runtime-xl"
    "chase-sets.com/environment" = var.environment
  }
  tags = distinct(concat(local.tags, ["runtime-xl"]))
}

# Dedicated PR-preview node pool (#4745). Preview workloads schedule here
# exclusively: the preview-only NoSchedule taint keeps staging pods off the
# pool, and the preview Helm deploy path adds the matching toleration plus a
# chase-sets.com/pool=preview nodeSelector so preview pods never land on the
# staging runtime node. min_nodes = 0 scales the pool to zero when no
# previews are running (m102 cost posture).
resource "digitalocean_kubernetes_node_pool" "preview" {
  count = local.preview_node_pool_enabled ? 1 : 0

  cluster_id = digitalocean_kubernetes_cluster.platform.id
  name       = "preview"
  size       = var.preview_node_pool_size
  auto_scale = true
  min_nodes  = 0
  max_nodes  = var.preview_node_pool_max_nodes
  labels = {
    "chase-sets.com/pool"        = "preview"
    "chase-sets.com/environment" = var.environment
  }
  tags = distinct(concat(local.tags, ["preview"]))

  taint {
    key    = local.preview_node_pool_taint.key
    value  = local.preview_node_pool_taint.value
    effect = local.preview_node_pool_taint.effect
  }
}

resource "digitalocean_kubernetes_node_pool" "additional" {
  for_each = var.additional_node_pools

  cluster_id = digitalocean_kubernetes_cluster.platform.id
  name       = each.key
  size       = each.value.size
  auto_scale = each.value.auto_scale
  node_count = each.value.auto_scale ? null : each.value.node_count
  min_nodes  = each.value.auto_scale ? each.value.min_nodes : null
  max_nodes  = each.value.auto_scale ? each.value.max_nodes : null
  labels = merge(
    {
      "chase-sets.com/pool"        = each.key
      "chase-sets.com/environment" = var.environment
    },
    each.value.labels,
  )
  tags = distinct(concat(local.tags, each.value.tags))

  dynamic "taint" {
    for_each = each.value.taints
    content {
      key    = taint.value.key
      value  = taint.value.value
      effect = taint.value.effect
    }
  }
}

check "production_runtime_pool_floor" {
  assert {
    condition = var.environment != "production" || (
      var.runtime_node_pool_auto_scale ? local.runtime_min_nodes >= 2 : local.runtime_node_count >= 2
    )
    error_message = "Production DOKS runtime capacity must start with at least two nodes."
  }
}

check "runtime_pool_autoscale_bounds" {
  assert {
    condition     = !var.runtime_node_pool_auto_scale || local.runtime_max_nodes >= local.runtime_min_nodes
    error_message = "runtime_node_pool_max_nodes must be greater than or equal to runtime_node_pool_min_nodes when autoscaling is enabled."
  }
}
