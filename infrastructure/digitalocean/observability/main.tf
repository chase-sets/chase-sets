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
  backups    = true
  tags       = local.tags
  volume_ids = [digitalocean_volume.observability_data.id]

  user_data = templatefile("${path.module}/templates/cloud-init.yml.tftpl", {
    environment      = var.environment
    volume_name      = local.volume_name
    write_files_yaml = local.cloud_init_write_files_yaml
  })
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
