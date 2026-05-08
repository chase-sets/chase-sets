locals {
  is_production = var.environment == "production"
  name_prefix   = local.is_production ? "chase-sets" : "chase-sets-${var.environment}"

  public_domains = local.is_production ? [
    var.root_domain,
    "www.${var.root_domain}",
    ] : [
    "${var.environment}.${var.root_domain}",
  ]

  admin_domain = local.is_production ? "admin.${var.root_domain}" : "admin-${var.environment}.${var.root_domain}"

  context_databases = {
    auth            = "chase_sets_${var.environment}_auth"
    catalog         = "chase_sets_${var.environment}_catalog"
    control         = "chase_sets_${var.environment}_control"
    experience      = "chase_sets_${var.environment}_experience"
    identity        = "chase_sets_${var.environment}_identity"
    public-presence = "chase_sets_${var.environment}_public_presence"
  }

  context_database_users = {
    auth            = "cs_${var.environment}_auth"
    catalog         = "cs_${var.environment}_catalog"
    control         = "cs_${var.environment}_control"
    experience      = "cs_${var.environment}_experience"
    identity        = "cs_${var.environment}_identity"
    public-presence = "cs_${var.environment}_public_presence"
  }

  context_database_env = {
    auth            = "DATABASE_URL_AUTH"
    catalog         = "DATABASE_URL_CATALOG"
    experience      = "DATABASE_URL_EXPERIENCE"
    identity        = "DATABASE_URL_IDENTITY"
    public-presence = "DATABASE_URL_PUBLIC_PRESENCE"
  }

  public_web_instances = local.is_production ? 2 : 1
  api_instances        = local.is_production ? 2 : 1
  admin_web_instances  = 1
  worker_instances     = 1
  deploy_on_push       = !local.is_production
}
