import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/repo.mjs";

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function resourceBlock(content, type, name) {
  const resourceStart = new RegExp(`resource\\s+"${type}"\\s+"${name}"\\s+\\{`, "g");
  const match = resourceStart.exec(content);
  if (!match) {
    throw new Error(`Missing Terraform resource ${type}.${name}.`);
  }

  let depth = 0;
  for (let index = match.index; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") {
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(match.index, index + 1);
      }
    }
  }

  throw new Error(`Terraform resource ${type}.${name} is not closed.`);
}

function expectLifecyclePreventDestroy(block) {
  expect(block).toMatch(/lifecycle\s*\{[\s\S]*prevent_destroy\s*=\s*true[\s\S]*\}/);
}

describe("DigitalOcean stateful infrastructure guards", () => {
  it("prevents accidental destruction of the platform Postgres cluster", () => {
    const block = resourceBlock(
      readRepoFile("infrastructure/digitalocean/platform/main.tf"),
      "digitalocean_database_cluster",
      "postgres",
    );

    expectLifecyclePreventDestroy(block);
  });

  it("prevents accidental destruction of the observability data volume", () => {
    const block = resourceBlock(
      readRepoFile("infrastructure/digitalocean/observability/main.tf"),
      "digitalocean_volume",
      "observability_data",
    );

    expectLifecyclePreventDestroy(block);
  });

  it("keeps Catalog asset buckets private and protected from accidental destruction", () => {
    const block = resourceBlock(
      readRepoFile("infrastructure/digitalocean/catalog-assets/main.tf"),
      "digitalocean_spaces_bucket",
      "catalog_assets",
    );

    expect(block).toMatch(/\bacl\s*=\s*"private"/);
    expect(block).not.toMatch(/\bacl\s*=\s*"public-read"/);
    expectLifecyclePreventDestroy(block);
  });

  it("preserves public delivery as an object-level ACL on Catalog asset uploads", () => {
    const adapter = readRepoFile("infrastructure/object-storage/index.ts");

    expect(adapter).toMatch(/new PutObjectCommand\(\{[\s\S]*ACL:\s*"public-read"[\s\S]*\}\)/);
  });
});
