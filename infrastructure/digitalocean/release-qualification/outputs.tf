output "release_qualification_bucket_name" {
  value = digitalocean_spaces_bucket.release_qualification.name
}

output "release_qualification_bucket_endpoint" {
  value = digitalocean_spaces_bucket.release_qualification.endpoint
}
