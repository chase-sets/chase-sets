resource "digitalocean_volume" "observability_data" {
  region                  = var.region
  name                    = local.volume_name
  size                    = var.volume_size_gib
  description             = "Persistent ${var.environment} observability data for Chase Sets."
  initial_filesystem_type = "ext4"
  tags                    = local.tags
}

resource "digitalocean_droplet" "observability" {
  image      = var.droplet_image
  name       = local.name_prefix
  region     = var.region
  size       = var.droplet_size
  ssh_keys   = var.ssh_key_fingerprints
  monitoring = true
  backups    = var.droplet_backups_enabled
  tags       = local.tags
  volume_ids = [digitalocean_volume.observability_data.id]

  user_data = local.cloud_init_user_data
}

resource "digitalocean_firewall" "observability" {
  name        = "${local.name_prefix}-firewall"
  droplet_ids = [digitalocean_droplet.observability.id]
  tags        = local.tags

  dynamic "inbound_rule" {
    for_each = length(var.ssh_source_addresses) > 0 ? [1] : []
    content {
      protocol         = "tcp"
      port_range       = "22"
      source_addresses = var.ssh_source_addresses
    }
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "all"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "all"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_record" "observability_a" {
  for_each = toset(["grafana", "otel", "prometheus"])

  domain = local.dns_zone
  type   = "A"
  name   = each.key
  value  = digitalocean_droplet.observability.ipv4_address
  ttl    = 60
}

check "observability_storage_posture" {
  assert {
    condition = var.environment == "staging" ? (
      !var.droplet_backups_enabled &&
      var.volume_size_gib <= 100 &&
      var.acceptable_telemetry_data_loss_window_hours <= 24
      ) : (
      var.volume_size_gib >= 100 &&
      var.acceptable_telemetry_data_loss_window_hours <= 24
    )
    error_message = "Staging observability keeps droplet backups off, volume size at or below 100 GiB, and a 24h-or-better telemetry data loss window; production keeps at least 100 GiB and a 24h-or-better window."
  }
}

check "observability_retention_posture" {
  assert {
    condition     = contains(["24h", "48h", "72h", "7d", "14d", "30d"], var.prometheus_retention)
    error_message = "prometheus_retention must be one of the documented cost-aware retention windows: 24h, 48h, 72h, 7d, 14d, or 30d."
  }
}

check "observability_cloud_init_size" {
  assert {
    condition     = length(local.cloud_init_user_data) < 64000
    error_message = "Rendered observability cloud-init user_data must stay below DigitalOcean's 64 KB Droplet API limit."
  }
}

check "observability_stack_file_classification" {
  assert {
    condition     = length(local.unclassified_stack_files) == 0
    error_message = "Every file under infrastructure/observability/stack must be deployed by the observability Terraform root or listed in local.stack_file_exclusions with a comment."
  }
}
