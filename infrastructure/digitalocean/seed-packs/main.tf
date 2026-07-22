# Governed representative-catalog Observation Pack storage (issues #5872 and #5874).
#
# Accepted packs have no age-based expiry. Revocation or supersession deletes the
# current object; versioning turns the retained payload into a noncurrent version,
# and this lifecycle rule removes that data within the approved 30-day window.
resource "digitalocean_spaces_bucket" "seed_packs" {
  name   = var.seed_packs_bucket_name
  region = var.region
  acl    = "private"

  versioning {
    enabled = true
  }

  lifecycle_rule {
    id      = "delete-revoked-or-superseded-pack-versions"
    enabled = true

    expiration {
      expired_object_delete_marker = true
    }

    noncurrent_version_expiration {
      days = 30
    }

    abort_incomplete_multipart_upload_days = 7
  }

  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_spaces_key" "dev" {
  name = "chase-sets-dev-seed-packs"

  grant {
    bucket     = digitalocean_spaces_bucket.seed_packs.name
    permission = "readwrite"
  }
}

resource "digitalocean_spaces_key" "ci" {
  name = "chase-sets-ci-seed-packs"

  grant {
    bucket     = digitalocean_spaces_bucket.seed_packs.name
    permission = "readwrite"
  }
}
