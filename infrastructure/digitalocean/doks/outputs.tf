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
