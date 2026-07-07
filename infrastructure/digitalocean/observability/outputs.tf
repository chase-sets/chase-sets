output "droplet_id" {
  value = digitalocean_droplet.observability.id
}

output "droplet_ipv4_address" {
  value = digitalocean_droplet.observability.ipv4_address
}

output "grafana_url" {
  value = "https://grafana.${local.environment_zones["production"]}"
}

output "otlp_endpoint" {
  value = "https://otel.${local.environment_zones["production"]}"
}

output "prometheus_url" {
  value = "https://prometheus.${local.environment_zones["production"]}"
}

output "environment_endpoints" {
  value = {
    for environment, zone in local.environment_zones : environment => {
      grafana_url    = "https://grafana.${zone}"
      otlp_endpoint  = "https://otel.${zone}"
      prometheus_url = "https://prometheus.${zone}"
    }
  }
}

output "app_platform_otlp_headers" {
  value     = "X-Chase-Sets-Observability-Token=${var.otel_write_token}"
  sensitive = true
}
