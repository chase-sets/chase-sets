locals {
  is_production = var.environment == "production"
  dns_zone      = local.is_production ? var.root_domain : "${var.environment}.${var.root_domain}"
  name_prefix   = local.is_production ? "chase-sets-observability" : "chase-sets-${var.environment}-observability"
  volume_name   = "${local.name_prefix}-data"
  tags          = [var.environment, "observability", "managed-by-terraform"]

  grafana_domain    = "grafana.${local.dns_zone}"
  otel_domain       = "otel.${local.dns_zone}"
  prometheus_domain = "prometheus.${local.dns_zone}"

  stack_source_dir = "${path.module}/../../observability/stack"

  stack_file_paths = sort(fileset(local.stack_source_dir, "**/*"))
  stack_files = {
    for relative_path in local.stack_file_paths :
    relative_path => file("${local.stack_source_dir}/${relative_path}")
  }

  generated_stack_files = {
    "docker-compose.yml" = templatefile("${path.module}/templates/docker-compose.yml.tftpl", {})
    ".env" = templatefile("${path.module}/templates/stack.env.tftpl", {
      caddy_image          = var.caddy_image
      grafana_image        = var.grafana_image
      prometheus_image     = var.prometheus_image
      loki_image           = var.loki_image
      tempo_image          = var.tempo_image
      otel_collector_image = var.otel_collector_image
      grafana_admin_user   = var.grafana_admin_user
      grafana_admin_pass   = var.grafana_admin_password
      grafana_domain       = local.grafana_domain
      prometheus_retention = var.prometheus_retention
    })
    "Caddyfile" = templatefile("${path.module}/templates/Caddyfile.tftpl", {
      acme_email             = var.acme_email
      grafana_domain         = local.grafana_domain
      otel_domain            = local.otel_domain
      prometheus_domain      = local.prometheus_domain
      otel_write_token       = var.otel_write_token
      prometheus_query_token = var.prometheus_query_token
    })
  }

  cloud_init_files = [
    for relative_path, content in merge(local.stack_files, local.generated_stack_files) : {
      path        = "/opt/chase-sets-observability/${relative_path}"
      owner       = "root:root"
      permissions = relative_path == ".env" || relative_path == "Caddyfile" ? "0600" : "0644"
      encoding    = "gz+b64"
      content     = base64gzip(content)
    }
  ]

  cloud_init_write_files_yaml = join("\n", [
    for write_file in local.cloud_init_files : join("\n", [
      "  - path: ${write_file.path}",
      "    owner: \"${write_file.owner}\"",
      "    permissions: \"${write_file.permissions}\"",
      "    encoding: ${write_file.encoding}",
      "    content: ${write_file.content}",
    ])
  ])

  cloud_init_user_data = templatefile("${path.module}/templates/cloud-init.yml.tftpl", {
    environment      = var.environment
    volume_name      = local.volume_name
    write_files_yaml = local.cloud_init_write_files_yaml
  })
}
