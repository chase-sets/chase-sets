output "cluster_id" {
  value = digitalocean_kubernetes_cluster.platform.id
}

output "cluster_name" {
  value = digitalocean_kubernetes_cluster.platform.name
}

output "cluster_urn" {
  value = digitalocean_kubernetes_cluster.platform.urn
}

output "cluster_endpoint" {
  value = digitalocean_kubernetes_cluster.platform.endpoint
}

output "kubeconfig" {
  value     = digitalocean_kubernetes_cluster.platform.kube_config[0].raw_config
  sensitive = true
}

output "container_registry_server_url" {
  value = local.container_registry_server_url
}

output "registry_integration_enabled" {
  value = digitalocean_kubernetes_cluster.platform.registry_integration
}

output "runtime_xl_node_pool" {
  description = "Dedicated staging runtime capacity (#4756); null when the pool is disabled or outside staging."
  value = local.runtime_xl_node_pool_enabled ? {
    name       = digitalocean_kubernetes_node_pool.runtime_xl[0].name
    size       = digitalocean_kubernetes_node_pool.runtime_xl[0].size
    node_count = digitalocean_kubernetes_node_pool.runtime_xl[0].node_count
    pool_label = "chase-sets.com/pool=runtime-xl"
  } : null
}

output "preview_node_pool" {
  description = "Dedicated PR-preview node pool posture (#4745); null when the pool is disabled or outside staging."
  value = local.preview_node_pool_enabled ? {
    name      = digitalocean_kubernetes_node_pool.preview[0].name
    size      = digitalocean_kubernetes_node_pool.preview[0].size
    min_nodes = digitalocean_kubernetes_node_pool.preview[0].min_nodes
    max_nodes = digitalocean_kubernetes_node_pool.preview[0].max_nodes
    taint     = local.preview_node_pool_taint
  } : null
}
