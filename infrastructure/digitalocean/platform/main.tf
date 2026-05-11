moved {
  from = digitalocean_app.landing
  to   = digitalocean_app.platform
}

resource "digitalocean_database_cluster" "postgres" {
  name       = "${local.name_prefix}-postgres"
  engine     = "pg"
  version    = var.postgres_version
  size       = local.database_size
  region     = var.region
  node_count = var.database_node_count
  tags       = [var.environment, "platform", "managed-by-terraform"]
}

resource "digitalocean_database_db" "contexts" {
  for_each   = local.context_databases
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = each.value
}

resource "digitalocean_database_user" "contexts" {
  for_each   = local.context_database_users
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = each.value
}

resource "digitalocean_database_connection_pool" "contexts" {
  for_each = local.staging_connection_pool_contexts

  cluster_id = digitalocean_database_cluster.postgres.id
  name       = "${each.key}-runtime"
  mode       = "transaction"
  size       = 1
  db_name    = digitalocean_database_db.contexts[each.key].name
  user       = digitalocean_database_user.contexts[each.key].name
}

resource "terraform_data" "context_database_grants" {
  triggers_replace = concat(
    [digitalocean_database_cluster.postgres.id],
    [
      for context_name in sort(keys(local.context_databases)) :
      "${digitalocean_database_db.contexts[context_name].id}:${digitalocean_database_user.contexts[context_name].id}"
    ],
  )

  provisioner "local-exec" {
    working_dir = "${path.module}/../../.."
    command     = "node scripts/apply-digitalocean-database-grant.mjs"

    environment = {
      DATABASE_GRANTS_JSON = jsonencode([
        for context_name in sort(keys(local.context_databases)) : {
          database = digitalocean_database_db.contexts[context_name].name
          user     = digitalocean_database_user.contexts[context_name].name
        }
      ])
      PGDATABASE = digitalocean_database_db.contexts[sort(keys(local.context_databases))[0]].name
      PGHOST     = digitalocean_database_cluster.postgres.host
      PGPASSWORD = digitalocean_database_cluster.postgres.password
      PGPORT     = tostring(digitalocean_database_cluster.postgres.port)
      PGSSLMODE  = "require"
      PGUSER     = digitalocean_database_cluster.postgres.user
    }
  }

  depends_on = [
    digitalocean_database_db.contexts,
    digitalocean_database_user.contexts,
  ]
}

resource "digitalocean_app" "platform" {
  spec {
    name   = "${local.name_prefix}-platform"
    region = var.region

    dynamic "domain" {
      for_each = local.public_domains
      content {
        name = domain.value
        type = tostring(domain.key) == "0" ? "PRIMARY" : "ALIAS"
        zone = var.root_domain
      }
    }

    dynamic "domain" {
      for_each = local.legacy_public_redirect_domains
      content {
        name = domain.value
        type = "ALIAS"
        zone = var.root_domain
      }
    }

    dynamic "domain" {
      for_each = local.marketplace_domains
      content {
        name = domain.value
        type = "ALIAS"
        zone = var.root_domain
      }
    }

    domain {
      name = local.admin_domain
      type = "ALIAS"
      zone = var.root_domain
    }

    alert {
      rule = "DEPLOYMENT_FAILED"
      dynamic "destinations" {
        for_each = length(var.alert_emails) > 0 ? [1] : []
        content {
          emails = var.alert_emails
        }
      }
    }

    dynamic "database" {
      for_each = local.is_staging ? {} : local.context_databases
      content {
        name         = "db-${database.key}"
        engine       = "PG"
        production   = true
        cluster_name = digitalocean_database_cluster.postgres.name
        db_name      = database.value
        db_user      = digitalocean_database_user.contexts[database.key].name
      }
    }

    service {
      name               = "public-web"
      run_command        = "pnpm --filter @chase-sets/app-public-web run start"
      instance_size_slug = var.app_instance_size_slug
      instance_count     = local.public_web_instances
      http_port          = 8080

      image {
        registry_type = "DOCR"
        repository    = var.platform_image_repository
        tag           = var.platform_image_tag

        deploy_on_push {
          enabled = false
        }
      }

      env {
        key   = "NODE_ENV"
        value = "production"
        scope = "RUN_AND_BUILD_TIME"
      }

      env {
        key   = "PORT"
        value = "8080"
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_PUBLIC_ORIGIN"
        value = "https://${local.landing_domain}"
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_PUBLIC_INDEXING"
        value = local.is_production ? "true" : "false"
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_DISCORD_INVITE_URL"
        value = var.discord_invite_url
        type  = "SECRET"
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_INTERNAL_API_ORIGIN"
        value = local.api_private_url
        scope = "RUN_TIME"
      }

      health_check {
        http_path = "/"
      }
    }

    dynamic "service" {
      for_each = local.is_staging ? [1] : []
      content {
        name               = "marketplace"
        run_command        = "pnpm --filter @chase-sets/app-marketplace-web run start"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = local.public_web_instances
        http_port          = 8080

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        env {
          key   = "PORT"
          value = "8080"
          scope = "RUN_TIME"
        }

        env {
          key   = "CHASE_SETS_INTERNAL_API_ORIGIN"
          value = "$${platform-api.PRIVATE_URL}"
          scope = "RUN_TIME"
        }

        env {
          key   = "CHASE_SETS_MARKETPLACE_INDEXING"
          value = local.is_production ? "true" : "false"
          scope = "RUN_TIME"
        }

        health_check {
          http_path = "/"
        }
      }
    }

    service {
      name               = "admin-web"
      run_command        = "pnpm --filter @chase-sets/app-admin-web run start"
      instance_size_slug = var.app_instance_size_slug
      instance_count     = local.admin_web_instances
      http_port          = 8080

      image {
        registry_type = "DOCR"
        repository    = var.platform_image_repository
        tag           = var.platform_image_tag

        deploy_on_push {
          enabled = false
        }
      }

      env {
        key   = "NODE_ENV"
        value = "production"
        scope = "RUN_AND_BUILD_TIME"
      }

      env {
        key   = "PORT"
        value = "8080"
        scope = "RUN_TIME"
      }

      env {
        key   = "CHASE_SETS_INTERNAL_API_ORIGIN"
        value = local.api_private_url
        scope = "RUN_TIME"
      }

      health_check {
        http_path = "/health/ready"
      }
    }

    dynamic "service" {
      for_each = local.is_staging ? [1] : []
      content {
        name               = "platform-api"
        run_command        = "pnpm --filter @chase-sets/app-platform-api run start:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = local.api_instances
        http_port          = 8080

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        env {
          key   = "PORT"
          value = "8080"
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PLATFORM_INTERNAL_AUTH_SECRET"
          value = var.platform_internal_auth_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_SECRET_KEY"
          value = var.stripe_secret_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_PUBLISHABLE_KEY"
          value = var.stripe_publishable_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_WEBHOOK_SECRET"
          value = var.stripe_webhook_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_API_BASE_URL"
          value = var.stripe_api_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_CONNECT_RETURN_URL"
          value = var.stripe_connect_return_url
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_CONNECT_REFRESH_URL"
          value = var.stripe_connect_refresh_url
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_API_KEY"
          value = var.easypost_api_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_API_BASE_URL"
          value = var.easypost_api_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_MODE"
          value = var.easypost_mode
          scope = "RUN_TIME"
        }

        env {
          key   = "REALTIME_STREAM_LIMITER"
          value = "postgres"
          scope = "RUN_TIME"
        }

        env {
          key   = "DEPLOYMENT_ENVIRONMENT"
          value = var.environment
          scope = "RUN_TIME"
        }

        health_check {
          http_path = "/health/ready"
        }
      }
    }

    dynamic "service" {
      for_each = local.is_staging ? [] : [1]
      content {
        name               = "admin-support-api"
        run_command        = "pnpm --filter @chase-sets/app-admin-support-api run start:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = local.api_instances
        http_port          = 8080

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        env {
          key   = "PORT"
          value = "8080"
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PLATFORM_INTERNAL_AUTH_SECRET"
          value = var.platform_internal_auth_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "ADMIN_REGISTRATION_ENABLED"
          value = "false"
          scope = "RUN_TIME"
        }

        health_check {
          http_path = "/health/ready"
        }
      }
    }

    dynamic "service" {
      for_each = local.is_staging ? [1] : []
      content {
        name               = "platform-worker"
        run_command        = "pnpm --filter @chase-sets/app-platform-worker run start:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = local.worker_instances
        http_port          = 8080

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        env {
          key   = "PORT"
          value = "8080"
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "STRIPE_SECRET_KEY"
          value = var.stripe_secret_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_PUBLISHABLE_KEY"
          value = var.stripe_publishable_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_WEBHOOK_SECRET"
          value = var.stripe_webhook_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_API_BASE_URL"
          value = var.stripe_api_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_CONNECT_RETURN_URL"
          value = var.stripe_connect_return_url
          scope = "RUN_TIME"
        }

        env {
          key   = "STRIPE_CONNECT_REFRESH_URL"
          value = var.stripe_connect_refresh_url
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_API_KEY"
          value = var.easypost_api_key
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_API_BASE_URL"
          value = var.easypost_api_base_url
          scope = "RUN_TIME"
        }

        env {
          key   = "EASYPOST_MODE"
          value = var.easypost_mode
          scope = "RUN_TIME"
        }

        env {
          key   = "DEPLOYMENT_ENVIRONMENT"
          value = var.environment
          scope = "RUN_TIME"
        }

        health_check {
          http_path = "/health/ready"
        }
      }
    }

    dynamic "worker" {
      for_each = local.is_staging ? [] : [1]
      content {
        name               = "admin-support-worker"
        run_command        = "pnpm --filter @chase-sets/app-admin-support-worker run start:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = local.worker_instances

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }
      }
    }

    dynamic "job" {
      for_each = local.is_staging ? [1] : []
      content {
        name               = "platform-bootstrap"
        kind               = "PRE_DEPLOY"
        run_command        = "pnpm --filter @chase-sets/app-platform-api run bootstrap:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = 1

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PLATFORM_INTERNAL_AUTH_SECRET"
          value = var.platform_internal_auth_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_EMAIL"
          value = var.platform_admin_email
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_PASSWORD"
          value = var.platform_admin_password
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_DISPLAY_NAME"
          value = var.platform_admin_display_name
          scope = "RUN_TIME"
        }
      }
    }

    dynamic "job" {
      for_each = local.is_staging ? [] : [1]
      content {
        name               = "admin-support-bootstrap"
        kind               = "PRE_DEPLOY"
        run_command        = "pnpm --filter @chase-sets/app-admin-support-api run bootstrap:production"
        instance_size_slug = var.app_instance_size_slug
        instance_count     = 1

        image {
          registry_type = "DOCR"
          repository    = var.platform_image_repository
          tag           = var.platform_image_tag

          deploy_on_push {
            enabled = false
          }
        }

        env {
          key   = "NODE_ENV"
          value = "production"
          scope = "RUN_AND_BUILD_TIME"
        }

        env {
          key   = "DATABASE_POOL_MAX"
          value = local.database_pool_max
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_IDLE_TIMEOUT_MS"
          value = local.database_pool_idle_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "DATABASE_POOL_CONNECTION_TIMEOUT_MS"
          value = local.database_pool_connection_timeout_ms
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_CONTROL_DATABASE_URL"
          value = local.context_database_urls["control"]
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        dynamic "env" {
          for_each = local.context_database_env
          content {
            key   = env.value
            value = local.context_database_urls[env.key]
            type  = "SECRET"
            scope = "RUN_TIME"
          }
        }

        env {
          key   = "PLATFORM_INTERNAL_AUTH_SECRET"
          value = var.platform_internal_auth_secret
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_EMAIL"
          value = var.platform_admin_email
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_PASSWORD"
          value = var.platform_admin_password
          type  = "SECRET"
          scope = "RUN_TIME"
        }

        env {
          key   = "PLATFORM_ADMIN_DISPLAY_NAME"
          value = var.platform_admin_display_name
          scope = "RUN_TIME"
        }
      }
    }

    ingress {
      dynamic "rule" {
        for_each = local.legacy_public_redirect_domains
        content {
          match {
            authority {
              exact = rule.value
            }
            path {
              prefix = "/"
            }
          }
          redirect {
            authority     = local.landing_domain
            scheme        = "https"
            redirect_code = 302
          }
        }
      }

      dynamic "rule" {
        for_each = local.public_domains
        content {
          match {
            authority {
              exact = rule.value
            }
            path {
              prefix = "/api"
            }
          }
          component {
            name                 = local.api_component_name
            preserve_path_prefix = true
          }
        }
      }

      rule {
        match {
          authority {
            exact = local.admin_domain
          }
          path {
            prefix = "/api"
          }
        }
        component {
          name                 = local.api_component_name
          preserve_path_prefix = true
        }
      }

      dynamic "rule" {
        for_each = local.marketplace_domains
        content {
          match {
            authority {
              exact = rule.value
            }
            path {
              prefix = "/api"
            }
          }
          component {
            name                 = "platform-api"
            preserve_path_prefix = true
          }
        }
      }

      dynamic "rule" {
        for_each = local.public_domains
        content {
          match {
            authority {
              exact = rule.value
            }
            path {
              prefix = "/"
            }
          }
          component {
            name                 = "public-web"
            preserve_path_prefix = true
          }
        }
      }

      rule {
        match {
          authority {
            exact = local.admin_domain
          }
          path {
            prefix = "/"
          }
        }
        component {
          name                 = "admin-web"
          preserve_path_prefix = true
        }
      }

      dynamic "rule" {
        for_each = local.marketplace_domains
        content {
          match {
            authority {
              exact = rule.value
            }
            path {
              prefix = "/"
            }
          }
          component {
            name                 = "marketplace"
            preserve_path_prefix = true
          }
        }
      }
    }
  }

  depends_on = [
    digitalocean_database_db.contexts,
    digitalocean_database_user.contexts,
    terraform_data.context_database_grants,
  ]
}
