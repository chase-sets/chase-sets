# Deterministic schema-backed plan. The mock provider uses the installed
# DigitalOcean provider schema but performs no API or Spaces operations.
mock_provider "digitalocean" {}

run "approved_seed_pack_storage_contract" {
  command = plan

  variables {
    digitalocean_token = "withheld-provider-test-token"
    spaces_access_id   = "withheld-provider-test-access-id"
    spaces_secret_key  = "withheld-provider-test-secret-key"
  }

  assert {
    condition     = digitalocean_spaces_bucket.seed_packs.name == "cs-dev-seed-packs"
    error_message = "The #5872-approved seed-pack bucket name changed."
  }

  assert {
    condition     = digitalocean_spaces_bucket.seed_packs.acl == "private"
    error_message = "The seed-pack Space must remain private."
  }

  assert {
    condition     = digitalocean_spaces_bucket.seed_packs.versioning[0].enabled
    error_message = "The seed-pack Space must remain versioned."
  }

  assert {
    condition     = one(digitalocean_spaces_bucket.seed_packs.lifecycle_rule[0].expiration).expired_object_delete_marker
    error_message = "Expired delete markers must be removed."
  }

  assert {
    condition     = one(digitalocean_spaces_bucket.seed_packs.lifecycle_rule[0].noncurrent_version_expiration).days == 30
    error_message = "Revoked or superseded payload versions must expire within 30 days."
  }

  assert {
    condition     = digitalocean_spaces_key.dev.grant[0].bucket == digitalocean_spaces_bucket.seed_packs.name && digitalocean_spaces_key.dev.grant[0].permission == "readwrite"
    error_message = "The dev key must be read/write and scoped only to the seed-pack Space."
  }

  assert {
    condition     = digitalocean_spaces_key.ci.grant[0].bucket == digitalocean_spaces_bucket.seed_packs.name && digitalocean_spaces_key.ci.grant[0].permission == "readwrite"
    error_message = "The CI key must be read/write and scoped only to the seed-pack Space."
  }
}
