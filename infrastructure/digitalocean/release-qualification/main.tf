# Durable release-qualification evidence Space (issue #5836).
#
# This bucket is the promotion authority for merge-queue qualification
# records. It is deliberately the ONLY resource in this root: the ratified
# cost wager (epic #5496, 2026-07-21) allows one private bucket on the
# existing Spaces subscription and nothing else.
#
# Versioning protects recovery from accidental overwrite or delete. It is
# not object lock and offers no cryptographic immutability against a
# DigitalOcean account administrator.
resource "digitalocean_spaces_bucket" "release_qualification" {
  name   = var.release_qualification_bucket_name
  region = var.region
  acl    = "private"

  versioning {
    enabled = true
  }

  # Evidence-retention horizon: keep current and non-current record versions
  # for at least 400 days, then let lifecycle expiry reclaim the storage so
  # the bucket stays inside the cost wager.
  lifecycle_rule {
    id      = "release-qualification-evidence-retention"
    enabled = true

    expiration {
      days = 400
    }

    noncurrent_version_expiration {
      days = 400
    }

    abort_incomplete_multipart_upload_days = 7
  }

  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}
