resource "digitalocean_spaces_bucket" "terraform_state" {
  name   = var.state_bucket_name
  region = var.region
  acl    = "private"

  versioning {
    enabled = true
  }

  force_destroy = false
}
