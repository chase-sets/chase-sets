locals {
  name_prefix = "chase-sets-observability"
  volume_name = "${local.name_prefix}-data"
  tags        = ["shared", "observability", "managed-by-terraform"]

  environment_zones = {
    for environment in var.observability_environments :
    environment => environment == "production" ? var.root_domain : "${environment}.${var.root_domain}"
  }
  endpoint_names       = toset(["grafana", "otel", "prometheus"])
  endpoint_dns_records = { for pair in setproduct(var.observability_environments, local.endpoint_names) : "${pair[0]}-${pair[1]}" => { environment = pair[0], name = pair[1] } }

  grafana_domains        = [for environment in sort(tolist(var.observability_environments)) : "grafana.${local.environment_zones[environment]}"]
  otel_domains           = [for environment in sort(tolist(var.observability_environments)) : "otel.${local.environment_zones[environment]}"]
  prometheus_domains     = [for environment in sort(tolist(var.observability_environments)) : "prometheus.${local.environment_zones[environment]}"]
  primary_grafana_domain = "grafana.${local.environment_zones["production"]}"

  stack_source_dir = "${path.module}/../../observability/stack"

  # Every checked-in stack file is deployed unless it is listed here with a
  # comment explaining why the file is intentionally local-only.
  stack_file_exclusions = toset([])

  stack_file_paths = sort(tolist(setsubtract(fileset(local.stack_source_dir, "**/*"), local.stack_file_exclusions)))
  stack_files = {
    for relative_path in local.stack_file_paths :
    relative_path => file("${local.stack_source_dir}/${relative_path}")
  }
  unclassified_stack_files = setsubtract(
    fileset(local.stack_source_dir, "**/*"),
    setunion(toset(keys(local.stack_files)), local.stack_file_exclusions)
  )

  generated_stack_files = {
    "collector-config.yml" = templatefile("${path.module}/templates/collector-config.yml.tftpl", {
      stack_environment = var.stack_environment
    })
    "prometheus.yml" = templatefile("${path.module}/templates/prometheus.yml.tftpl", {
      stack_environment = var.stack_environment
    })
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
      grafana_domain       = local.primary_grafana_domain
      prometheus_retention = var.prometheus_retention
    })
    "Caddyfile" = templatefile("${path.module}/templates/Caddyfile.tftpl", {
      acme_email             = var.acme_email
      grafana_domains        = join(", ", local.grafana_domains)
      otel_domains           = join(", ", local.otel_domains)
      prometheus_domains     = join(", ", local.prometheus_domains)
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
    environment      = var.stack_environment
    volume_name      = local.volume_name
    write_files_yaml = local.cloud_init_write_files_yaml
  })
}
