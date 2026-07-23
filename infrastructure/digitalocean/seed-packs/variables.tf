variable "digitalocean_token" {
  type      = string
  sensitive = true
}

# Broad Terraform automation credentials used by the provider to manage the
# bucket. Runtime pack readers and writers use only the scoped keys created by
# this root.
variable "spaces_access_id" {
  type      = string
  sensitive = true
}

variable "spaces_secret_key" {
  type      = string
  sensitive = true
}

variable "region" {
  type    = string
  default = "nyc3"
}

variable "seed_packs_bucket_name" {
  type    = string
  default = "cs-dev-seed-packs"
}
