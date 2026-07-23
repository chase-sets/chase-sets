output "seed_packs_bucket_name" {
  value = digitalocean_spaces_bucket.seed_packs.name
}

output "seed_packs_bucket_endpoint" {
  value = digitalocean_spaces_bucket.seed_packs.endpoint
}

output "seed_packs_bucket_origin" {
  value = digitalocean_spaces_bucket.seed_packs.bucket_domain_name
}

output "dev_spaces_access_id" {
  value     = digitalocean_spaces_key.dev.access_key
  sensitive = true
}

output "dev_spaces_secret_key" {
  value     = digitalocean_spaces_key.dev.secret_key
  sensitive = true
}

output "ci_spaces_access_id" {
  value     = digitalocean_spaces_key.ci.access_key
  sensitive = true
}

output "ci_spaces_secret_key" {
  value     = digitalocean_spaces_key.ci.secret_key
  sensitive = true
}
