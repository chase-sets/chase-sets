variable "digitalocean_token" {
  type      = string
  sensitive = true
}

# Terraform-time Spaces credentials for creating/managing the bucket. These
# are the existing broad Terraform automation credentials used by every
# remote-state root; the RUNTIME record reader/writer never uses them — it
# uses only the dedicated bucket-scoped RELEASE_EVIDENCE_SPACES_* key.
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

variable "release_qualification_bucket_name" {
  type    = string
  default = "chase-sets-release-qualification"
}
