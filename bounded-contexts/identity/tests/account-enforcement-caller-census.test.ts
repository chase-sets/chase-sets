import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const identityRoot = path.resolve(import.meta.dirname, "..");

function source(relativePath: string) {
  return readFileSync(path.join(identityRoot, relativePath), "utf8");
}

function productionSources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = path.join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      return ["tests", "node_modules"].includes(entry) ? [] : productionSources(fullPath);
    }
    return /\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.(ts|tsx)$/.test(entry) ? [fullPath] : [];
  });
}

describe("Account enforcement caller census", () => {
  it("keeps the complete production command-dispatcher list closed", () => {
    const commandObject = /type:\s*"(SuspendAccount|ReactivateAccount|CloseAccount)"/g;
    const callers = productionSources(identityRoot)
      .filter((file) => !file.endsWith(path.join("features", "accounts", "domain", "domain.ts")))
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(commandObject)].map((match) => ({
          file: path.relative(identityRoot, file).replaceAll("\\", "/"),
          command: match[1],
        })),
      );

    expect(callers).toEqual([
      { file: "features/accounts/api/route.ts", command: "SuspendAccount" },
      { file: "features/accounts/api/route.ts", command: "ReactivateAccount" },
      { file: "features/accounts/api/route.ts", command: "CloseAccount" },
      { file: "support/runtime-support/seed.ts", command: "SuspendAccount" },
    ]);

    const seed = source("support/runtime-support/seed.ts");
    expect(seed.match(/DORMANT_ACCOUNT_ENFORCEMENT_ACTION_ID/g)).toHaveLength(2);
    expect(seed).toContain('reason: "operator-other"');
    expect(seed).toContain("reference: null");
  });

  it("keeps the registered operator chain and both form origins intact", () => {
    const client = source("support/shell-support/api/client.ts");
    const registeredRoute = source("routes/admin/accounts-detail.tsx");
    const accountDetail = source("features/accounts/ui/account-detail-page.tsx");
    const accessHub = source("features/access-hub/ui/account-access-hub-page.tsx");

    for (const method of ["suspendAccount", "reactivateAccount", "closeAccount"]) {
      expect(client).toContain(`async ${method}<T>`);
      expect(registeredRoute).toContain(`api.${method}(accountId)`);
    }
    for (const intent of ["suspend", "reactivate", "close"]) {
      expect(accountDetail).toContain(`value="${intent}"`);
      expect(accessHub).toContain(`value="${intent}"`);
    }
    expect(source("features/accounts/api/mcp.ts")).not.toMatch(/suspend|reactivate|close/i);
  });
});
