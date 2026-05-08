output "app_id" {
  value = digitalocean_app.landing.id
}

output "live_url" {
  value = digitalocean_app.landing.live_url
}

output "postgres_cluster_id" {
  value = digitalocean_database_cluster.postgres.id
}

output "database_users" {
  value     = { for key, user in digitalocean_database_user.contexts : key => user.name }
  sensitive = true
}

output "public_domains" {
  value = local.public_domains
}

output "admin_domain" {
  value = local.admin_domain
}
