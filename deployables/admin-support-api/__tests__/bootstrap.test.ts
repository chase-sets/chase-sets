import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const bootstrapSource = readFileSync(
  resolve(currentDir, "../src/bootstrap.ts"),
  "utf8",
);

describe("admin-support bootstrap profile", () => {
  it("uses production-safe seed orchestration only", () => {
    expect(bootstrapSource).toContain("bootstrapCatalogDatabase");
    expect(bootstrapSource).toContain("bootstrapPlatformAdminIdentity");
    expect(bootstrapSource).toContain("bootstrapPlatformAdminPassword");
    expect(bootstrapSource).not.toContain("seedApiHostIfEmpty");
    expect(bootstrapSource).not.toContain("seedAuthDatabase");
    expect(bootstrapSource).not.toContain("seedIdentityDatabase");
    expect(bootstrapSource).not.toContain("seedPublicPresence");
  });
});
