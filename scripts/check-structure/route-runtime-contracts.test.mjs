import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectRouteRuntimeContractViolations } from "./route-runtime-contracts.mjs";

const tempRoots = [];

function createRepo(routeSource) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "route-runtime-contracts-"));
  tempRoots.push(rootDir);
  const routeDirectory = path.join(rootDir, "bounded-contexts", "inventory", "routes");
  mkdirSync(routeDirectory, { recursive: true });
  writeFileSync(path.join(routeDirectory, "account-inventory.tsx"), routeSource, "utf8");
  return rootDir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("route runtime contracts", () => {
  it("rejects route-owned read-after-write and intent dispatch ceremony", async () => {
    const rootDir = createRepo(`
      export async function loader() { return loadAfterWrite({}); }
      export async function action() { const intent = "save"; return intent; }
    `);

    await expect(collectRouteRuntimeContractViolations({ rootDir })).resolves.toEqual([
      { file: "bounded-contexts/inventory/routes/account-inventory.tsx", kind: "direct-load-after-write" },
      { file: "bounded-contexts/inventory/routes/account-inventory.tsx", kind: "route-owned-intent-dispatch" },
    ]);
  });

  it("accepts runtime-owned resource and form action contracts", async () => {
    const rootDir = createRepo(`
      export const loader = defineResourceRoute({});
      export const action = defineFormAction({ intents: { save: () => null } });
    `);

    await expect(collectRouteRuntimeContractViolations({ rootDir })).resolves.toEqual([]);
  });

  it("keeps every production route on the runtime contracts", async () => {
    const rootDir = path.resolve(import.meta.dirname, "../..");
    await expect(collectRouteRuntimeContractViolations({ rootDir })).resolves.toEqual([]);
  }, 30_000);
});
