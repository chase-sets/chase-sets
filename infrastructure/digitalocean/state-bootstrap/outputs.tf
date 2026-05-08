output "state_bucket_name" {
  value = digitalocean_spaces_bucket.terraform_state.name
}

output "state_bucket_endpoint" {
  value = digitalocean_spaces_bucket.terraform_state.endpoint
}
