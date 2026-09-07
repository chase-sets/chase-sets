import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../../../context.json" with { type: "json" };
import packageJson from "../../../package.json" with { type: "json" };

describe("channel-connection-scope-fence", () => {
  it("keeps provider execution, setup replacement, UI, and public connect or activate routes absent", () => {
    const sliceRoot = path.resolve(import.meta.dirname, "..");
    const files = listFiles(sliceRoot);
    const route = readFileSync(path.join(sliceRoot, "api/route.ts"), "utf8");
    expect(files.some((file) => file.startsWith("ui/") || file.startsWith("integrations/"))).toBe(false);
    expect(findForbiddenRoutes(route)).toEqual([]);
    expect(route).not.toMatch(/credentialReference\?|bindings\s*:/);
    expect(JSON.stringify(manifest)).not.toContain("landing");
    expect(JSON.stringify(manifest)).not.toMatch(/providerRegistry|readAfterWriteRouteInventory/);

    const mutant = `${route}\napp.post("/connect", handler);\n`;
    expect(findForbiddenRoutes(mutant)).toEqual(["/connect"]);
  });

  it("pins the finite unit/DB discovery partition to exactly the two named DB files", () => {
    const dbFiles = [
      "features/connections/tests/channel-connection-setup-activation.db.test.ts",
      "features/connections/tests/channel-connection-projection-concurrency.db.test.ts",
    ];
    expect(packageJson.chaseSets).toEqual({ testProfile: "db" });
    for (const file of dbFiles) {
      expect(packageJson.scripts["test:db"]).toContain(file);
      expect(packageJson.scripts["test:unit"]).toContain(`--exclude ${file}`);
    }
  });
});

function findForbiddenRoutes(source: string): string[] {
  return [...source.matchAll(/app\.post\("(\/[^"\n]*)"/g)]
    .map((match) => match[1])
    .filter((route) => route === "/connect" || route.includes("/activate"));
}

function listFiles(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, absolute) : [path.relative(root, absolute).replaceAll("\\", "/")];
  });
}
