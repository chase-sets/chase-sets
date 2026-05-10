data "digitalocean_domain" "root" {
  name = var.root_domain
}

resource "digitalocean_database_cluster" "postgres" {
  name       = "${local.name_prefix}-postgres"
  engine     = "pg"
  version    = var.postgres_version
  size       = var.database_size
  region     = var.region
  node_count = var.database_node_count
  tags       = [var.environment, "landing", "managed-by-terraform"]
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

resource "terraform_data" "context_database_grants" {
  for_each = local.context_databases

  triggers_replace = [
    digitalocean_database_db.contexts[each.key].name,
    digitalocean_database_user.contexts[each.key].name,
  ]

  provisioner "local-exec" {
    working_dir = "${path.module}/../../.."
    command     = "node scripts/apply-digitalocean-database-grant.mjs"

    environment = {
      DATABASE_GRANT_NAME = digitalocean_database_db.contexts[each.key].name
      DATABASE_GRANT_USER = digitalocean_database_user.contexts[each.key].name
      PGDATABASE          = digitalocean_database_db.contexts[each.key].name
      PGHOST              = digitalocean_database_cluster.postgres.host
      PGPASSWORD          = digitalocean_database_cluster.postgres.password
      PGPORT              = tostring(digitalocean_database_cluster.postgres.port)
      PGSSLMODE           = "require"
      PGUSER              = digitalocean_database_cluster.postgres.user
    }
  }

  depends_on = [
    digitalocean_database_db.contexts,
    digitalocean_database_user.contexts,
  ]
}

resource "digitalocean_app" "landing" {
  spec {
    name   = "${local.name_prefix}-landing"
    region = var.region

    dynamic "domain" {
      for_each = local.public_domains
      content {
        name = domain.value
        type = tostring(domain.key) == "0" ? "PRIMARY" : "ALIAS"
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
      for_each = local.context_databases
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
      source_dir         = "/"
      build_command      = "npm install -g pnpm@11.0.9 && pnpm install --frozen-lockfile && pnpm run sync:workspace-metadata && pnpm --filter @chase-sets/app-public-web run build"
      run_command        = "pnpm --filter @chase-sets/app-public-web run start"
      environment_slug   = "node-js"
      instance_size_slug = var.app_instance_size_slug
      instance_count     = local.public_web_instances
      http_port          = 8080

      github {
        repo           = var.repo
        branch         = var.branch
        deploy_on_push = local.deploy_on_push
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
        value = local.is_production ? "https://${var.root_domain}" : "https://${local.public_domains[0]}"
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
        value = "$${admin-support-api.PRIVATE_URL}"
        scope = "RUN_TIME"
      }

      health_check {
        http_path = "/"
      }
    }

    service {
      name               = "admin-web"
      source_dir         = "/"
      build_command      = "npm install -g pnpm@11.0.9 && pnpm install --frozen-lockfile && pnpm run sync:workspace-metadata && pnpm --filter @chase-sets/app-admin-web run build"
      run_command        = "pnpm --filter @chase-sets/app-admin-web run start"
      environment_slug   = "node-js"
      instance_size_slug = var.app_instance_size_slug
      instance_count     = local.admin_web_instances
      http_port          = 8080

      github {
        repo           = var.repo
        branch         = var.branch
        deploy_on_push = local.deploy_on_push
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
        value = "$${admin-support-api.PRIVATE_URL}"
        scope = "RUN_TIME"
      }

      health_check {
        http_path = "/health/ready"
      }
    }

    service {
      name               = "admin-support-api"
      source_dir         = "/"
      build_command      = "npm install -g pnpm@11.0.9 && pnpm install --frozen-lockfile && pnpm run sync:workspace-metadata && pnpm --filter @chase-sets/app-admin-support-api run build"
      run_command        = "pnpm --filter @chase-sets/app-admin-support-api run start:production"
      environment_slug   = "node-js"
      instance_size_slug = var.app_instance_size_slug
      instance_count     = local.api_instances
      http_port          = 8080

      github {
        repo           = var.repo
        branch         = var.branch
        deploy_on_push = local.deploy_on_push
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
        key   = "PLATFORM_CONTROL_DATABASE_URL"
        value = "$${db-control.DATABASE_URL}"
        type  = "SECRET"
        scope = "RUN_TIME"
      }

      dynamic "env" {
        for_each = local.context_database_env
        content {
          key   = env.value
          value = format("$${db-%s.DATABASE_URL}", env.key)
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

    worker {
      name               = "admin-support-worker"
      source_dir         = "/"
      build_command      = "npm install -g pnpm@11.0.9 && pnpm install --frozen-lockfile && pnpm run sync:workspace-metadata && pnpm --filter @chase-sets/app-admin-support-worker run build"
      run_command        = "pnpm --filter @chase-sets/app-admin-support-worker run start:production"
      environment_slug   = "node-js"
      instance_size_slug = var.app_instance_size_slug
      instance_count     = local.worker_instances

      github {
        repo           = var.repo
        branch         = var.branch
        deploy_on_push = local.deploy_on_push
      }

      env {
        key   = "NODE_ENV"
        value = "production"
        scope = "RUN_AND_BUILD_TIME"
      }

      env {
        key   = "PLATFORM_CONTROL_DATABASE_URL"
        value = "$${db-control.DATABASE_URL}"
        type  = "SECRET"
        scope = "RUN_TIME"
      }

      dynamic "env" {
        for_each = local.context_database_env
        content {
          key   = env.value
          value = format("$${db-%s.DATABASE_URL}", env.key)
          type  = "SECRET"
          scope = "RUN_TIME"
        }
      }
    }

    job {
      name               = "admin-support-bootstrap"
      kind               = "PRE_DEPLOY"
      source_dir         = "/"
      build_command      = "npm install -g pnpm@11.0.9 && pnpm install --frozen-lockfile && pnpm run sync:workspace-metadata"
      run_command        = "pnpm --filter @chase-sets/app-admin-support-api run bootstrap:production"
      environment_slug   = "node-js"
      instance_size_slug = var.app_instance_size_slug
      instance_count     = 1

      github {
        repo           = var.repo
        branch         = var.branch
        deploy_on_push = local.deploy_on_push
      }

      env {
        key   = "NODE_ENV"
        value = "production"
        scope = "RUN_AND_BUILD_TIME"
      }

      env {
        key   = "PLATFORM_CONTROL_DATABASE_URL"
        value = "$${db-control.DATABASE_URL}"
        type  = "SECRET"
        scope = "RUN_TIME"
      }

      dynamic "env" {
        for_each = local.context_database_env
        content {
          key   = env.value
          value = format("$${db-%s.DATABASE_URL}", env.key)
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

    ingress {
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
            name                 = "admin-support-api"
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
          name                 = "admin-support-api"
          preserve_path_prefix = true
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
    }
  }

  depends_on = [
    digitalocean_database_db.contexts,
    digitalocean_database_user.contexts,
    terraform_data.context_database_grants,
  ]
}
