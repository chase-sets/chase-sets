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

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

describe("DigitalOcean platform configuration", () => {
  it("keeps staging landing on the active dash-based App Platform host", () => {
    expect(platformLocals).toContain(
      'local.is_staging ? "landing-${var.environment}.${var.root_domain}"',
    );
    expect(platformLocals).not.toContain(
      'local.is_staging ? "${var.environment}.${var.root_domain}"',
    );
    expect(platformLocals).not.toContain(
      '"landing-${var.environment}.${var.root_domain}"     = local.landing_domain',
    );
  });

  it("wires production admin-support Catalog asset storage into the API and bootstrap job", () => {
    for (const key of [
      "CATALOG_ASSET_STORAGE_KIND",
      "CATALOG_ASSET_S3_BUCKET",
      "CATALOG_ASSET_S3_REGION",
      "CATALOG_ASSET_S3_ENDPOINT",
      "CATALOG_ASSET_PUBLIC_BASE_URL",
      "CATALOG_ASSET_S3_ACCESS_KEY_ID",
      "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
    ]) {
      expect(occurrenceCount(platformMain, `key   = "${key}"`)).toBe(2);
    }

    expect(platformMain).toContain('name               = "admin-support-api"');
    expect(platformMain).toContain('name               = "admin-support-bootstrap"');
    expect(platformMain).toContain("value = var.spaces_access_id");
    expect(platformMain).toContain("value = var.spaces_secret_key");
    expect(platformLocals).toContain("catalog_asset_s3_endpoint");
    expect(platformLocals).toContain("catalog_asset_public_base_url");
    expect(platformVariables).toContain('variable "catalog_asset_s3_bucket"');
    expect(platformVariables).toContain('variable "catalog_asset_public_base_url"');
  });
});
