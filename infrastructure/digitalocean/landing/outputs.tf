output "app_id" {
  value = digitalocean_app.landing.id
}

output "live_url" {
  value = digitalocean_app.landing.live_url
}

output "postgres_cluster_id" {
  value = digitalocean_database_cluster.postgres.id
}

output "public_domains" {
  value = local.public_domains
}

output "admin_domain" {
  value = local.admin_domain
}
