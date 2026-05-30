import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const platformMain = readFileSync(resolve("infrastructure/digitalocean/platform/main.tf"), "utf8");
const platformLocals = readFileSync(resolve("infrastructure/digitalocean/platform/locals.tf"), "utf8");
const platformOutputs = readFileSync(resolve("infrastructure/digitalocean/platform/outputs.tf"), "utf8");
const platformVariables = readFileSync(resolve("infrastructure/digitalocean/platform/variables.tf"), "utf8");
const catalogAssetsMain = readFileSync(resolve("infrastructure/digitalocean/catalog-assets/main.tf"), "utf8");
const catalogAssetsLocals = readFileSync(resolve("infrastructure/digitalocean/catalog-assets/locals.tf"), "utf8");
const environmentDnsMain = readFileSync(resolve("infrastructure/digitalocean/environment-dns/main.tf"), "utf8");
const environmentDnsLocals = readFileSync(resolve("infrastructure/digitalocean/environment-dns/locals.tf"), "utf8");
const environmentDnsVariables = readFileSync(
  resolve("infrastructure/digitalocean/environment-dns/variables.tf"),
  "utf8",
);
const platformProductionWorkflow = readFileSync(resolve(".github/workflows/platform-production.yml"), "utf8");
const platformStagingResetWorkflow = readFileSync(resolve(".github/workflows/platform-staging-reset.yml"), "utf8");
const platformRepresentativeWorkflow = readFileSync(
  resolve(".github/workflows/platform-staging-representative-commerce-state.yml"),
  "utf8",
);

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function workflowStep(source, stepName) {
  const start = source.indexOf(`- name: ${stepName}`);
  expect(start).not.toBe(-1);

  const next = source.indexOf("\n      - name:", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

describe("DigitalOcean platform configuration", () => {
  it("keeps staging landing under the environment namespace and redirects the legacy dash host", () => {
    expect(platformLocals).toContain('local.is_staging ? "www.${var.environment}.${var.root_domain}"');
    expect(platformLocals).not.toContain('local.is_staging ? "${var.environment}.${var.root_domain}"');
    expect(platformLocals).toContain('"landing-${var.environment}.${var.root_domain}"     = local.landing_domain');
  });

  it("wires Catalog asset storage into production and non-production Catalog promotion components", () => {
    for (const key of [
      "CATALOG_ASSET_STORAGE_KIND",
      "CATALOG_ASSET_S3_BUCKET",
      "CATALOG_ASSET_S3_REGION",
      "CATALOG_ASSET_S3_ENDPOINT",
      "CATALOG_ASSET_PUBLIC_BASE_URL",
      "CATALOG_ASSET_S3_ACCESS_KEY_ID",
      "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
    ]) {
      expect(occurrenceCount(platformMain, `key   = "${key}"`)).toBe(6);
    }

    expect(platformMain).toContain('name               = "platform-api"');
    expect(platformMain).toContain('name               = "platform-worker"');
    expect(platformMain).toContain('name               = "platform-bootstrap"');
    expect(platformMain).toContain('name               = "admin-support-api"');
    expect(platformMain).toContain('name               = "admin-support-worker"');
    expect(platformMain).toContain('name               = "admin-support-bootstrap"');
    expect(platformMain).toContain("value = var.spaces_access_id");
    expect(platformMain).toContain("value = var.spaces_secret_key");
    expect(platformLocals).toContain("catalog_asset_s3_endpoint");
    expect(platformLocals).toContain("chase-sets-preview-catalog-assets");
    expect(platformLocals).toContain("https://assets.preview.${var.root_domain}");
    expect(platformLocals).toContain("catalog_asset_public_base_url");
    expect(platformOutputs).toContain('output "catalog_asset_public_base_url"');
    expect(platformVariables).not.toContain('variable "catalog_asset_s3_bucket"');
    expect(platformVariables).not.toContain('variable "catalog_asset_public_base_url"');
  });

  it("keeps shared Catalog asset buckets and CDN domains in their own stable root", () => {
    expect(catalogAssetsMain).toContain('resource "digitalocean_spaces_bucket" "catalog_assets"');
    expect(catalogAssetsMain).toContain('acl           = "public-read"');
    expect(catalogAssetsMain).toContain('resource "digitalocean_cdn" "catalog_assets"');
    expect(catalogAssetsMain).toContain('resource "digitalocean_certificate" "catalog_assets_cdn"');
    expect(catalogAssetsMain).not.toContain("digitalocean_record");
    expect(catalogAssetsLocals).toContain('preview    = "chase-sets-preview-catalog-assets"');
    expect(catalogAssetsLocals).toContain('staging    = "assets.staging.${var.root_domain}"');
    expect(catalogAssetsLocals).toContain('production = "assets.${var.root_domain}"');
    expect(platformStagingResetWorkflow).toContain("Verify staging catalog asset CDN");
    expect(platformStagingResetWorkflow).toContain("terraform import digitalocean_cdn.catalog_assets");
    expect(platformStagingResetWorkflow).toContain("doctl compute cdn list --output json");
    expect(platformStagingResetWorkflow).toContain("doctl compute domain records list chasesets.com --output json");
    expect(platformStagingResetWorkflow).toContain('"https://${custom_domain}/" >/dev/null');
    expect(platformProductionWorkflow).toContain("catalog_asset_public_base_url");
    expect(platformProductionWorkflow).toContain('"${catalog_asset_public_base_url}/" >/dev/null');
  });

  it("routes non-production UCP agent discovery and transport paths to platform-api", () => {
    expect(platformLocals).toContain('ucp_route_prefixes   = ["/.well-known", "/ucp"]');
    expect(platformLocals).toContain("ucp_ingress_routes");
    expect(platformMain).toContain("for_each = local.ucp_ingress_routes");
    expect(platformMain).toContain("prefix = rule.value.path_prefix");
    expect(platformMain).toContain('name                 = "platform-api"');
  });

  it("wires Google Workspace SSO into production admin-support API", () => {
    expect(platformMain).toContain('name               = "admin-support-api"');
    expect(occurrenceCount(platformMain, 'key   = "GOOGLE_SOCIAL_LOGIN_CLIENT_ID"')).toBe(3);
    expect(occurrenceCount(platformMain, 'key   = "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET"')).toBe(3);
    expect(occurrenceCount(platformMain, 'key   = "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS"')).toBe(3);
  });

  it("keeps App Platform database and runner budgets explicit by component", () => {
    expect(platformLocals).toContain('api_database_pool_max               = "6"');
    expect(platformLocals).toContain('worker_database_pool_max            = local.is_non_production ? "8" : "6"');
    expect(platformLocals).toContain('bootstrap_database_pool_max         = "4"');
    expect(platformLocals).toContain('worker_projection_concurrency       = "2"');
    expect(platformVariables).toContain('default     = "db-s-2vcpu-4gb"');
    expect(platformVariables).toContain('variable "staging_database_size"');
    expect(platformLocals).toContain("local.is_staging ? var.staging_database_size");
    expect(platformLocals).toContain("staging_context_database_connection_pool_sizes");
    expect(platformLocals).toContain("catalog         = 6");
    expect(platformLocals).toContain("control         = 4");
    expect(platformMain).toContain("size       = local.context_database_connection_pool_sizes[each.key]");
    expect(occurrenceCount(platformMain, "value = local.api_database_pool_max")).toBe(2);
    expect(occurrenceCount(platformMain, "value = local.worker_database_pool_max")).toBe(2);
    expect(occurrenceCount(platformMain, "value = local.bootstrap_database_pool_max")).toBe(2);
    expect(occurrenceCount(platformMain, 'key   = "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS"')).toBe(2);
  });

  it("routes staging root as the managed primary marketplace host", () => {
    expect(platformLocals).toContain('environment_zone    = "${var.environment}.${var.root_domain}"');
    expect(platformLocals).toContain("staging_root_marketplace_domains = local.is_staging");
    expect(platformLocals).toContain('"${var.environment}.${var.root_domain}"');
    expect(platformLocals).toContain(
      "all_marketplace_domains = concat(local.marketplace_domains, local.staging_root_marketplace_domains)",
    );
    expect(platformLocals).toContain(
      "app_primary_domain      = local.is_staging ? local.staging_root_marketplace_domains[0] : local.public_domains[0]",
    );
    expect(platformLocals).toContain(
      "concat(local.public_domains, [local.admin_domain], local.all_marketplace_domains)",
    );
    expect(platformLocals).toContain("for domain in local.all_marketplace_domains");
    expect(platformMain).toContain("for_each = local.staging_root_marketplace_domains");
    expect(platformMain).toContain("for_each = local.all_marketplace_domains");
    expect(platformMain).toContain('type = domain.value == local.app_primary_domain ? "PRIMARY" : "ALIAS"');
    expect(platformLocals).toContain("app_domain_zones = merge(");
    expect(platformLocals).toContain("domain => local.is_staging ? local.environment_zone : var.root_domain");
    expect(platformMain).toContain("zone = local.app_domain_zones[domain.value]");
    expect(platformMain).toContain("zone = local.app_domain_zones[local.admin_domain]");
    expect(platformLocals).toContain("staging_app_alias_record_names");
    expect(platformLocals).not.toContain("staging_root_app_platform_ipv4_records");
    expect(platformLocals).not.toContain("staging_root_app_platform_ipv6_records");
    expect(platformMain).toContain('resource "digitalocean_record" "staging_app_alias"');
    expect(platformMain).toContain('type   = "CNAME"');
    expect(platformMain).toContain("digitalocean_app.platform.default_ingress");
    expect(platformMain).not.toContain('resource "digitalocean_record" "staging_root_app_platform_ipv4"');
    expect(platformMain).not.toContain('resource "digitalocean_record" "staging_root_app_platform_ipv6"');
    expect(platformMain).toContain('name                 = "marketplace"');
    expect(platformMain).toContain('name                 = "platform-api"');
  });

  it("keeps production marketplace promotion explicitly gated", () => {
    expect(platformVariables).toContain('variable "production_marketplace_public_enabled"');
    expect(platformVariables).toContain("production_marketplace_public_enabled may only be true for production.");
    expect(platformVariables).toContain('variable "production_marketplace_promotion_approved"');
    expect(platformVariables).toContain("production_marketplace_promotion_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_marketplace_promotion_reference"');
    expect(platformVariables).toContain(
      "production_marketplace_promotion_reference is required when production_marketplace_promotion_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_marketplace_checkout_fee_approved"');
    expect(platformVariables).toContain(
      "production_marketplace_checkout_fee_approved may only be true for production.",
    );
    expect(platformVariables).toContain('variable "production_marketplace_checkout_fee_reference"');
    expect(platformVariables).toContain(
      "production_marketplace_checkout_fee_reference is required when production_marketplace_checkout_fee_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_stripe_money_operations_approved"');
    expect(platformVariables).toContain("production_stripe_money_operations_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_stripe_money_operations_reference"');
    expect(platformVariables).toContain(
      "production_stripe_money_operations_reference is required when production_stripe_money_operations_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_support_operations_approved"');
    expect(platformVariables).toContain("production_support_operations_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_support_operations_reference"');
    expect(platformVariables).toContain(
      "production_support_operations_reference is required when production_support_operations_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_fulfillment_postage_approved"');
    expect(platformVariables).toContain("production_fulfillment_postage_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_fulfillment_postage_reference"');
    expect(platformVariables).toContain(
      "production_fulfillment_postage_reference is required when production_fulfillment_postage_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_transactional_email_approved"');
    expect(platformVariables).toContain("production_transactional_email_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_transactional_email_reference"');
    expect(platformVariables).toContain(
      "production_transactional_email_reference is required when production_transactional_email_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_launch_supply_measurements_approved"');
    expect(platformVariables).toContain(
      "production_launch_supply_measurements_approved may only be true for production.",
    );
    expect(platformVariables).toContain('variable "production_launch_supply_measurements_reference"');
    expect(platformVariables).toContain(
      "production_launch_supply_measurements_reference is required when production_launch_supply_measurements_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_tax_readiness_approved"');
    expect(platformVariables).toContain("production_tax_readiness_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_tax_readiness_reference"');
    expect(platformVariables).toContain(
      "production_tax_readiness_reference is required when production_tax_readiness_approved is true.",
    );
    expect(platformVariables).toContain('startswith(var.stripe_secret_key, "sk_live")');
    expect(platformVariables).toContain('startswith(var.stripe_publishable_key, "pk_live")');
    expect(platformVariables).toContain('var.easypost_mode == "production"');
    expect(platformLocals).toContain("marketplace_platform_enabled = (");
    expect(platformLocals).toContain("local.is_non_production || var.production_marketplace_public_enabled");
    expect(platformLocals).toContain('local.is_production ? "marketplace.${var.root_domain}"');
    expect(platformLocals).toContain("context_names = local.marketplace_platform_enabled");
    expect(platformMain).toContain('check "production_marketplace_promotion"');
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires production environment and complete Amazon SES transactional email configuration."',
    );
    expect(platformMain).toContain('check "production_marketplace_launch_approval"');
    expect(platformMain).toContain("var.production_marketplace_promotion_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved launch evidence before deploying the public marketplace."',
    );
    expect(platformMain).toContain('check "production_marketplace_checkout_fee_approval"');
    expect(platformMain).toContain("var.production_marketplace_checkout_fee_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Marketplace Checkout Fee evidence before live checkout."',
    );
    expect(platformMain).toContain('check "production_stripe_money_operations_readiness"');
    expect(platformMain).toContain("var.production_stripe_money_operations_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Stripe money operations evidence before live payments and payouts."',
    );
    expect(platformMain).toContain('check "production_support_operations_readiness"');
    expect(platformMain).toContain("var.production_support_operations_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Support operations evidence before live order support."',
    );
    expect(platformMain).toContain('check "production_fulfillment_postage_readiness"');
    expect(platformMain).toContain("var.production_fulfillment_postage_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Fulfillment postage evidence before live shipment labels."',
    );
    expect(platformMain).toContain('check "production_transactional_email_readiness"');
    expect(platformMain).toContain("var.production_transactional_email_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved transactional email evidence before live marketplace notifications."',
    );
    expect(platformMain).toContain('check "production_launch_supply_measurements_readiness"');
    expect(platformMain).toContain("var.production_launch_supply_measurements_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved launch supply measurement evidence before public checkout."',
    );
    expect(platformMain).toContain('check "production_tax_readiness"');
    expect(platformMain).toContain("var.production_tax_readiness_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Tax readiness evidence before live order creation."',
    );
    expect(platformMain).toContain("for_each = local.marketplace_platform_enabled ? [1] : []");
    expect(platformMain).toContain("for_each = local.marketplace_platform_enabled ? [] : [1]");
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_public_enabled: ${{ vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_promotion_approved: ${{ vars.PRODUCTION_MARKETPLACE_PROMOTION_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_promotion_reference: ${{ vars.PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_checkout_fee_approved: ${{ vars.PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_checkout_fee_reference: ${{ vars.PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_stripe_money_operations_approved: ${{ vars.PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_stripe_money_operations_reference: ${{ vars.PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_support_operations_approved: ${{ vars.PRODUCTION_SUPPORT_OPERATIONS_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_support_operations_reference: ${{ vars.PRODUCTION_SUPPORT_OPERATIONS_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_fulfillment_postage_approved: ${{ vars.PRODUCTION_FULFILLMENT_POSTAGE_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_fulfillment_postage_reference: ${{ vars.PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_transactional_email_approved: ${{ vars.PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_transactional_email_reference: ${{ vars.PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_launch_supply_measurements_approved: ${{ vars.PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_launch_supply_measurements_reference: ${{ vars.PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_tax_readiness_approved: ${{ vars.PRODUCTION_TAX_READINESS_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_tax_readiness_reference: ${{ vars.PRODUCTION_TAX_READINESS_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain("Production marketplace promotion requires Stripe live-mode keys.");
    expect(platformProductionWorkflow).toContain("Production marketplace promotion requires approved launch evidence.");
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Marketplace Checkout Fee evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Stripe money operations evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Support operations evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Fulfillment postage evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved transactional email evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved launch supply measurement evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Tax readiness evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires NOTIFICATION_EMAIL_PROVIDER=amazon-ses.",
    );
    expect(platformProductionWorkflow).toContain('export SMOKE_REQUIRE_MARKETPLACE="true"');
  });

  it("delegates staging DNS so App Platform apex routing can coexist with mail records", () => {
    expect(environmentDnsVariables).toContain('condition     = var.environment == "staging"');
    expect(environmentDnsLocals).toContain('environment_zone = "${var.environment}.${var.root_domain}"');
    expect(environmentDnsMain).toContain('resource "digitalocean_domain" "environment"');
    expect(environmentDnsMain).toContain('resource "digitalocean_record" "delegation"');
    expect(environmentDnsMain).toContain('type   = "NS"');
    expect(environmentDnsMain).toContain('type     = "MX"');
    expect(environmentDnsLocals).toContain('value    = "smtp.google.com."');
    expect(environmentDnsMain).toContain('name   = "google._domainkey"');
    expect(environmentDnsMain).toContain('value  = "v=spf1 include:_spf.google.com ~all"');
    expect(environmentDnsMain).toContain('resource "digitalocean_record" "ses_dkim"');
    expect(environmentDnsMain).toContain('resource "digitalocean_record" "catalog_assets"');
    expect(environmentDnsLocals).toContain(
      'catalog_asset_cdn_endpoint = "chase-sets-${var.environment}-catalog-assets.${var.data_region}.cdn.digitaloceanspaces.com."',
    );
    expect(platformProductionWorkflow).toContain("Terraform apply staging environment DNS");
    expect(platformStagingResetWorkflow).toContain("Terraform apply staging environment DNS");
    expect(platformProductionWorkflow).toContain("Reconcile staging App Platform alias DNS state");
    expect(platformProductionWorkflow).toContain('doctl apps get "$app_id" --format DefaultIngress --no-header');
    expect(platformProductionWorkflow).toContain("TF_VAR_platform_internal_auth_secret");
    expect(platformProductionWorkflow).toContain('terraform import "$address" "${zone},${record_id}"');
    expect(workflowStep(platformProductionWorkflow, "Reconcile staging App Platform alias DNS state")).toContain(
      "TF_VAR_digitalocean_token",
    );
    expect(workflowStep(platformProductionWorkflow, "Reconcile staging App Platform alias DNS state")).toContain(
      "TF_VAR_platform_admin_password",
    );
    expect(workflowStep(platformProductionWorkflow, "Reconcile staging App Platform alias DNS state")).toContain(
      "TF_VAR_stripe_secret_key",
    );
    expect(workflowStep(platformProductionWorkflow, "Reconcile staging App Platform alias DNS state")).toContain(
      "TF_VAR_easypost_api_key",
    );
    expect(platformStagingResetWorkflow).toContain("Reconcile staging App Platform alias DNS state");
    expect(platformStagingResetWorkflow).toContain('doctl apps get "$app_id" --format DefaultIngress --no-header');
    expect(platformStagingResetWorkflow).toContain("TF_VAR_platform_internal_auth_secret");
    expect(platformStagingResetWorkflow).toContain('terraform import "$address" "${zone},${record_id}"');
    expect(platformProductionWorkflow).toContain("Reset stale staging root domain attachment");
    expect(platformProductionWorkflow).toContain('reset-domain "$app_id" staging.chasesets.com');
    expect(platformStagingResetWorkflow).toContain("Reset stale staging root domain attachment");
    expect(platformStagingResetWorkflow).toContain('reset-domain "$app_id" staging.chasesets.com');
  });

  it("splits app and data regions and manages uptime checks", () => {
    expect(platformVariables).toContain('variable "app_region"');
    expect(platformVariables).toContain('default     = "nyc"');
    expect(platformVariables).toContain('variable "data_region"');
    expect(platformVariables).toContain('default     = "nyc3"');
    expect(platformMain).toContain("region     = var.data_region");
    expect(platformMain).toContain("region = var.app_region");
    expect(platformMain).toContain('resource "digitalocean_uptime_check" "platform"');
    expect(platformMain).toContain('resource "digitalocean_uptime_alert" "platform_down"');
    expect(platformLocals).toContain("uptime_check_targets = merge(");
    expect(platformLocals).toContain("realtime_stream_limiter");
    expect(platformMain).toContain('check "api_realtime_coordination"');
  });

  it("keeps representative commerce refresh as an explicit staging-only operator workflow", () => {
    expect(platformRepresentativeWorkflow).toContain("environment: staging");
    expect(platformRepresentativeWorkflow).toContain("seed staging commerce");
    expect(platformRepresentativeWorkflow).toContain("DEPLOYMENT_ENVIRONMENT: staging");
    expect(platformRepresentativeWorkflow).toContain("REPRESENTATIVE_COMMERCE_STATE_CATALOG_ITEM_LIMIT");
    expect(platformRepresentativeWorkflow).toContain("terraform state pull");
    expect(platformRepresentativeWorkflow).toContain("digitalocean_database_connection_pool");
    expect(platformRepresentativeWorkflow).toContain("PLATFORM_CONTROL_DATABASE_URL");
    expect(platformRepresentativeWorkflow).toContain("DATABASE_URL_${String(contextName).toUpperCase()");
    expect(platformRepresentativeWorkflow).toContain("MARKETPLACE_LISTING_PHOTO_STORAGE_KIND: s3");
    expect(platformRepresentativeWorkflow).toContain(
      "pnpm --filter @chase-sets/app-platform-api run representative-commerce-state:production",
    );
    expect(platformProductionWorkflow).not.toContain("representative-commerce-state:production");
  });

  it("gates production promotion on staging marketplace critical flows", () => {
    const stagingCriticalFlowStep = workflowStep(platformProductionWorkflow, "Staging marketplace critical flows");
    const stagingMoneySmokeStep = workflowStep(platformProductionWorkflow, "Staging Stripe money smoke");
    const markStagingDeployedIndex = platformProductionWorkflow.indexOf("- name: Mark staging deployed");

    expect(platformProductionWorkflow).toContain("Install Playwright Chromium for staging critical flows");
    expect(stagingCriticalFlowStep).toContain("PLAYWRIGHT_SKIP_WEB_SERVER");
    expect(stagingCriticalFlowStep).toContain('MARKETPLACE_WEB_URL="https://${marketplace_domain}"');
    expect(stagingCriticalFlowStep).toContain("pnpm run test:e2e:deployed");
    expect(stagingCriticalFlowStep).toContain("MARKETPLACE_E2E_EMAIL");
    expect(stagingCriticalFlowStep).toContain("MARKETPLACE_E2E_PASSWORD");
    expect(stagingCriticalFlowStep).toContain("vars.MARKETPLACE_E2E_EMAIL || ''");
    expect(stagingCriticalFlowStep).toContain("secrets.MARKETPLACE_E2E_PASSWORD || ''");
    expect(stagingCriticalFlowStep).toContain("AWS_ACCESS_KEY_ID");
    expect(stagingCriticalFlowStep).toContain("AWS_SECRET_ACCESS_KEY");
    expect(platformProductionWorkflow).toContain("staging-playwright-critical-flow-artifacts");

    expect(stagingMoneySmokeStep).toContain("AWS_ACCESS_KEY_ID");
    expect(stagingMoneySmokeStep).toContain("AWS_SECRET_ACCESS_KEY");
    expect(stagingMoneySmokeStep).toContain("SMOKE_REGISTER_SELLER");
    expect(stagingMoneySmokeStep).toContain(
      "SMOKE_SELLER_DISPLAY_NAME: Stripe Staging Smoke ${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(stagingMoneySmokeStep).toContain(
      "STRIPE_CONNECT_RETURN_URL: https://marketplace.staging.chasesets.com/account/payouts",
    );
    expect(stagingMoneySmokeStep).toContain("STAGING_SMOKE_ORDER_IDS");
    expect(stagingMoneySmokeStep).toContain('PLATFORM_API_BASE_URL="https://${marketplace_domain}"');
    expect(stagingMoneySmokeStep).toContain("pnpm run stripe:money-smoke -- --edge-check --seller-flow");

    expect(platformProductionWorkflow.indexOf("- name: Staging marketplace critical flows")).toBeLessThan(
      markStagingDeployedIndex,
    );
    expect(platformProductionWorkflow.indexOf("- name: Staging Stripe money smoke")).toBeLessThan(
      markStagingDeployedIndex,
    );
  });
});
