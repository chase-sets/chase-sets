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

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
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
    expect(platformLocals).not.toContain("staging_app_alias_record_names");
    expect(platformLocals).not.toContain("staging_root_app_platform_ipv4_records");
    expect(platformLocals).not.toContain("staging_root_app_platform_ipv6_records");
    expect(platformMain).not.toContain('resource "digitalocean_record" "staging_app_alias"');
    expect(platformMain).not.toContain('resource "digitalocean_record" "staging_root_app_platform_ipv4"');
    expect(platformMain).not.toContain('resource "digitalocean_record" "staging_root_app_platform_ipv6"');
    expect(platformMain).not.toContain("digitalocean_app.platform.default_ingress");
    expect(platformMain).toContain('name                 = "marketplace"');
    expect(platformMain).toContain('name                 = "platform-api"');
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
});
