import { globSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVitest, parseCLI } from "vitest/node";
import { listWorkspacePackages } from "./lib/repo.mjs";
import { runWorkspaceScripts } from "./run-workspaces.mjs";

describe("Ordering hosted unit/DB partition", () => {
  it("selects Ordering test:unit without DB environment and discovers every non-DB test", async () => {
    const workspaces = listWorkspacePackages();
    const ordering = workspaces.find((entry) => entry.name === "@chase-sets/ordering");
    expect(ordering.packageJson.chaseSets.testProfile).toBe("db");
    const invocations = [];
    const environment = [];
    await runWorkspaceScripts({
      argv: ["test:unit", "--test-profile=db", "--workspace=@chase-sets/ordering"],
      listWorkspaces: () => workspaces,
      buildInvocation: (args) => ({ command: "pnpm", args }),
      loadEnvironment: (options) => environment.push(options),
      run: async (_command, args) => {
        invocations.push(args);
      },
    });
    expect(invocations).toEqual([["--filter", "@chase-sets/ordering", "run", "test:unit"]]);
    expect(environment).toEqual([{ includeTestDatabaseUrl: false }]);
    const scripts = ordering.packageJson.scripts;
    const {
      options: { exclude },
    } = parseCLI(scripts["test:unit"]);
    expect(exclude).toEqual(["**/*.db.test.ts", "**/*.db.test.tsx"]);
    const normalize = (file) => path.resolve(ordering.dir, file).replaceAll("\\", "/");
    const all = globSync("**/*.test.{ts,tsx}", { cwd: ordering.dir, exclude: ["node_modules/**"] }).map(normalize);
    const dbFiles = all.filter((file) => /\.db\.test\.tsx?$/.test(file)).sort();
    const unit = await createVitest("test", {
      root: ordering.dir,
      config: "./tests/vitest.config.mjs",
      watch: false,
      exclude,
    });
    try {
      const discovered = (await unit.globTestSpecifications()).map((spec) => spec.moduleId).sort();
      expect(discovered).toEqual(all.filter((file) => !dbFiles.includes(file)).sort());
      expect(discovered).toEqual(
        expect.arrayContaining(
          [
            "features/orders/ui/order-review-opportunity-callout.test.tsx",
            "tests/account-purchase-route.test.tsx",
            "tests/account-sale-route.test.tsx",
            "features/orders/api/route.test.ts",
          ].map(normalize),
        ),
      );
    } finally {
      await unit.close();
    }
    const db = await createVitest("test", { root: ordering.dir, config: "./tests/vitest.config.mjs", watch: false });
    try {
      const { filter } = parseCLI(scripts["test:db"]);
      expect((await db.globTestSpecifications(filter)).map((spec) => spec.moduleId).sort()).toEqual(dbFiles);
      expect(dbFiles).toContain(normalize("features/orders/integrations/reputation/reputation-projection.db.test.ts"));
    } finally {
      await db.close();
    }
  });
});
