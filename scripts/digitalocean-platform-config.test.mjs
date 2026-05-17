import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const platformMain = readFileSync(
  resolve("infrastructure/digitalocean/platform/main.tf"),
  "utf8",
);
const platformLocals = readFileSync(
  resolve("infrastructure/digitalocean/platform/locals.tf"),
  "utf8",
);
const platformVariables = readFileSync(
  resolve("infrastructure/digitalocean/platform/variables.tf"),
  "utf8",
);
const catalogAssetsMain = readFileSync(
  resolve("infrastructure/digitalocean/catalog-assets/main.tf"),
  "utf8",
);
const catalogAssetsLocals = readFileSync(
  resolve("infrastructure/digitalocean/catalog-assets/locals.tf"),
  "utf8",
);

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

describe("DigitalOcean platform configuration", () => {
  it("keeps staging landing under the environment namespace and routes the staging root to marketplace", () => {
    expect(platformLocals).toContain(
      'landing_domain      = local.is_production ? var.root_domain : local.is_staging ? "www.${var.environment}.${var.root_domain}"',
    );
    expect(platformLocals).toContain(
      'staging_root_domain = local.is_staging ? "${var.environment}.${var.root_domain}" : null',
    );
    expect(platformLocals).toContain(
      "marketplace_route_domains        = concat(local.marketplace_domains, local.staging_root_marketplace_domains)",
    );
    expect(platformMain).toContain("name = local.primary_domain");
    expect(platformMain).toContain("for_each = local.marketplace_route_domains");
    expect(platformLocals).toContain(
      "ucp_route_domains    = local.is_non_production ? concat(local.public_domains, [local.admin_domain], local.marketplace_route_domains) : []",
    );
    expect(platformLocals).toContain(
      '"landing-${var.environment}.${var.root_domain}"     = local.landing_domain',
    );
  });

  it("wires Catalog asset storage into production and non-production API/bootstrap components", () => {
    for (const key of [
      "CATALOG_ASSET_STORAGE_KIND",
      "CATALOG_ASSET_S3_BUCKET",
      "CATALOG_ASSET_S3_REGION",
      "CATALOG_ASSET_S3_ENDPOINT",
      "CATALOG_ASSET_PUBLIC_BASE_URL",
      "CATALOG_ASSET_S3_ACCESS_KEY_ID",
      "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
    ]) {
      expect(occurrenceCount(platformMain, `key   = "${key}"`)).toBe(4);
    }

    expect(platformMain).toContain('name               = "platform-api"');
    expect(platformMain).toContain('name               = "platform-bootstrap"');
    expect(platformMain).toContain('name               = "admin-support-api"');
    expect(platformMain).toContain('name               = "admin-support-bootstrap"');
    expect(platformMain).toContain("value = var.spaces_access_id");
    expect(platformMain).toContain("value = var.spaces_secret_key");
    expect(platformLocals).toContain("catalog_asset_s3_endpoint");
    expect(platformLocals).toContain("chase-sets-preview-catalog-assets");
    expect(platformLocals).toContain("https://assets.preview.${var.root_domain}");
    expect(platformLocals).toContain("catalog_asset_public_base_url");
    expect(platformVariables).not.toContain('variable "catalog_asset_s3_bucket"');
    expect(platformVariables).not.toContain('variable "catalog_asset_public_base_url"');
  });

  it("keeps shared Catalog asset buckets and CDN domains in their own stable root", () => {
    expect(catalogAssetsMain).toContain(
      'resource "digitalocean_spaces_bucket" "catalog_assets"',
    );
    expect(catalogAssetsMain).toContain('acl           = "public-read"');
    expect(catalogAssetsMain).toContain(
      'resource "digitalocean_cdn" "catalog_assets"',
    );
    expect(catalogAssetsMain).toContain(
      'resource "digitalocean_certificate" "catalog_assets_cdn"',
    );
    expect(catalogAssetsMain).not.toContain("digitalocean_record");
    expect(catalogAssetsLocals).toContain(
      'preview    = "chase-sets-preview-catalog-assets"',
    );
    expect(catalogAssetsLocals).toContain(
      'staging    = "assets.staging.${var.root_domain}"',
    );
    expect(catalogAssetsLocals).toContain(
      'production = "assets.${var.root_domain}"',
    );
  });

  it("routes non-production UCP agent discovery and transport paths to platform-api", () => {
    expect(platformLocals).toContain('ucp_route_prefixes   = ["/.well-known", "/ucp"]');
    expect(platformLocals).toContain("ucp_ingress_routes");
    expect(platformMain).toContain("for_each = local.ucp_ingress_routes");
    expect(platformMain).toContain("prefix = rule.value.path_prefix");
    expect(platformMain).toContain('name                 = "platform-api"');
  });
});
