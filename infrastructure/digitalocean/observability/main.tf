resource "digitalocean_volume" "observability_data" {
  region = var.region
  name   = local.volume_name
  size   = var.volume_size_gib
  # DigitalOcean treats description changes as ForceNew. Preserve the live
  # production-era description so shared-state adoption cannot replace the
  # durable telemetry volume; tags carry the current shared ownership model.
  description             = "Persistent production observability data for Chase Sets."
  initial_filesystem_type = "ext4"
  tags                    = local.tags

  lifecycle {
    prevent_destroy = true
  }
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

  lifecycle {
    prevent_destroy = true
    # Cloud-init is first-boot only. Checked-in stack changes are reconciled
    # in place per the runbook; changing user_data must never replace the
    # explicitly retained observability Droplet.
    ignore_changes = [user_data]
  }
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

moved {
  from = digitalocean_record.observability_a["grafana"]
  to   = digitalocean_record.observability_a["production-grafana"]
}

moved {
  from = digitalocean_record.observability_a["otel"]
  to   = digitalocean_record.observability_a["production-otel"]
}

moved {
  from = digitalocean_record.observability_a["prometheus"]
  to   = digitalocean_record.observability_a["production-prometheus"]
}

resource "digitalocean_record" "observability_a" {
  for_each = local.endpoint_dns_records

  domain = local.environment_zones[each.value.environment]
  type   = "A"
  name   = each.value.name
  value  = digitalocean_droplet.observability.ipv4_address
  ttl    = 60
}

check "observability_storage_posture" {
  assert {
    condition = (
      !var.droplet_backups_enabled &&
      var.volume_size_gib >= 50 &&
      var.volume_size_gib <= 100 &&
      var.acceptable_telemetry_data_loss_window_hours <= 24
    )
    error_message = "Shared pre-launch observability keeps droplet backups off, volume size between 50 and 100 GiB, and a 24h-or-better telemetry data loss window."
  }
}

check "observability_retention_posture" {
  assert {
    condition     = contains(["24h", "48h", "72h", "7d", "14d", "30d"], var.prometheus_retention)
    error_message = "prometheus_retention must be one of the documented cost-aware retention windows: 24h, 48h, 72h, 7d, 14d, or 30d."
  }
}

check "observability_alert_delivery" {
  assert {
    condition = !var.grafana_smtp_enabled || (
      length(var.alert_emails) > 0 &&
      trimspace(var.ses_aws_access_key_id) != "" &&
      trimspace(var.ses_aws_secret_access_key) != "" &&
      trimspace(var.ses_aws_region) != "" &&
      trimspace(var.ses_configuration_set_name) != "" &&
      trimspace(var.ses_source_arn) != "" &&
      trimspace(var.grafana_smtp_from_address) != ""
    )
    error_message = "Grafana alert delivery requires recipients, SES SendEmail credentials and region, and a verified from address."
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
