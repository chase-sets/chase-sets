output "droplet_id" {
  value = digitalocean_droplet.observability.id
}

output "droplet_ipv4_address" {
  value = digitalocean_droplet.observability.ipv4_address
}

output "grafana_url" {
  value = "https://${local.grafana_domain}"
}

output "otlp_endpoint" {
  value = "https://${local.otel_domain}"
}

output "prometheus_url" {
  value = "https://${local.prometheus_domain}"
}

output "app_platform_otlp_headers" {
  value     = "X-Chase-Sets-Observability-Token=${var.otel_write_token}"
  sensitive = true
}
