import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import ts from "@chase-sets/typescript-compiler-api";
import {
  findBootSchemaLedgerConvergenceViolations,
  findBootSchemaRetainedUpgradeViolations,
} from "./boot-schema-ddl-discipline.mjs";
import {
  findBrowserUnsafeLocalizationExport,
  findBrowserUnsafeLocalizationReachability,
  findRouteSupportPlacementViolation,
  isAdmittedFeatureMetadataFile,
  isAllowedPublicExportName,
  isCanonicalBoundedContextRootFile,
  isThinRouteAdapter,
  singleSliceSupportSeverity,
} from "./run.mjs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findServerBarrelReactFreeViolations } from "./server-barrel-react-free.mjs";
import { fileURLToPath } from "node:url";

const baseManifest = {
  directoryIntent: {
    "request-support": {
      classification: "support",
      crossCuttingRuntimeComposition: true,
    },
    "route-support": {
      classification: "support",
    },
    "shell-support": {
      classification: "support",
    },
  },
};

function violationFor(relativeFile, content, manifest = baseManifest) {
  return findRouteSupportPlacementViolation({
    relativeFile,
    content,
    contextManifest: manifest,
    isTest: false,
  });
}

describe("route support placement guard", () => {
  it("preserves ordinary R99 candidate acceptance and the exact stopped Settlement fresh-CREATE refusal", () => {
    const accountFile =
      "../../bounded-contexts/settlement/features/wallets/integrations/account-risk-source/account-risk-source-schema.ts";
    const candidate = readFileSync(new URL(accountFile, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
    const parsed = ts.createSourceFile(accountFile, candidate, ts.ScriptTarget.Latest, true);
    const ledger = parsed.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .find((node) => node.name.getText(parsed) === "settlementAccountRiskSourceSchemaMigrations")?.initializer;
    expect(ledger && ts.isAsExpression(ledger) && ts.isArrayLiteralExpression(ledger.expression)).toBe(true);
    const last = ledger.expression.elements.at(-1);
    const baseSource = `${candidate.slice(0, last.getFullStart())}\n] as const;\n`;
    const stopped = candidate.replace(
      "  account_id text PRIMARY KEY,",
      "  account_id text PRIMARY KEY,\n  revision bigint NOT NULL DEFAULT 0,",
    );
    expect(digest(candidate)).toBe("47c64402367e57c6f9bca8fc4aafcc7483aee1849e71ad2cce5ee12d7e4e36b5");
    expect(digest(baseSource)).toBe("a1de72122075c49e538ddf87e471c3ca29e3fb3775bd17a84041a5f49d24e610");
    // Exact LF bytes of the stopped 77ea12e schema, not a coarser synthetic SQL example.
    expect(digest(stopped)).toBe("c0d4c4dfd3a81a360336334e3f7f7ffb397bad3ebca065b1b43039bddec877ea");
    for (const currentSource of [candidate, stopped]) {
      const convergence = findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource });
      const refused = findBootSchemaRetainedUpgradeViolations({ baseSource, currentSource });
      expect(convergence).toEqual([]);
      expect(refused.map((entry) => entry.columnName)).toEqual(currentSource === stopped ? ["revision"] : []);
      console.info(
        `SETTLEMENT_R99_CONTROL ${currentSource === stopped ? "stopped-77ea12e" : "candidate"} convergence=${convergence.length} refusals=${refused.length}`,
      );
    }
  });

  it("publishes the Settlement risk reader only through the admitted server surface", async () => {
    expect(isAllowedPublicExportName("./server")).toBe(true);
    expect(isAllowedPublicExportName("./seller-checkout-risk")).toBe(false);
    const root = new URL("../../bounded-contexts/settlement/", import.meta.url);
    const read = (relative) => readFileSync(new URL(relative, root), "utf8");
    const manifest = JSON.parse(read("context.json"));
    const pkg = JSON.parse(read("package.json"));
    expect(manifest.publicExports).toEqual(Object.keys(pkg.exports));
    expect(manifest.publicExports.every(isAllowedPublicExportName)).toBe(true);
    expect(pkg.exports["./server"]).toBe("./server.ts");
    expect(pkg.exports).not.toHaveProperty("./seller-checkout-risk");
    const facade = read("features/seller-checkout-risk/api/public.ts");
    for (const symbol of [
      "createSellerCheckoutRiskReader",
      "readSellerCheckoutRisk",
      "SellerCheckoutRiskOwner",
      "SellerCheckoutRiskResult",
      "SellerCheckoutRiskReader",
    ]) {
      expect(read("server.ts")).toContain(symbol);
      expect(facade).toContain(symbol);
    }
    expect(read("server.ts")).toContain('from "./features/seller-checkout-risk/api/public"');
    expect(read("index.ts")).not.toMatch(/seller-checkout-risk|export\s+\*.*server/);
    const violations = await findServerBarrelReactFreeViolations({
      repoRoot: fileURLToPath(new URL("../../", import.meta.url)),
      contextManifests: new Map([
        ["bounded-contexts/settlement", { root: "bounded-contexts/settlement", packageName: pkg.name }],
      ]),
    });
    expect(violations).toEqual([]);
  });

  it("recognizes thin route adapters and rejects behavior in migrated adapters", () => {
    expect(isThinRouteAdapter('export { loader, action } from "../features/catalog/ui/route";')).toBe(true);
    expect(isThinRouteAdapter('export async function loader() { return new Response("owned here"); }')).toBe(false);
  });

  it("keeps the exact localization surface browser-safe", () => {
    expect(findBrowserUnsafeLocalizationExport('export { catalog } from "./features/catalog/locales";')).toBe(false);
    expect(findBrowserUnsafeLocalizationExport('import fs from "node:fs"; export const catalog = {};')).toBe(true);
    expect(findBrowserUnsafeLocalizationExport('import "node:fs"; export const catalog = {};')).toBe(true);
    expect(findBrowserUnsafeLocalizationExport('export { loader } from "./server";')).toBe(true);
    expect(isAllowedPublicExportName("./localization")).toBe(true);
    expect(isAllowedPublicExportName("./localization/catalog")).toBe(false);
  });

  it("follows localization re-exports through the context root", () => {
    const contextRoot = mkdtempSync(path.join(tmpdir(), "chase-sets-localization-"));
    try {
      const target = path.join(contextRoot, "localization.ts");
      mkdirSync(path.join(contextRoot, "features"), { recursive: true });
      writeFileSync(target, 'export { catalog } from "./features/catalog";\n');
      writeFileSync(path.join(contextRoot, "features", "catalog.ts"), 'import { readFileSync } from "node:fs";\n');
      expect(findBrowserUnsafeLocalizationReachability({ contextRoot, targetPath: target })).toBe(
        path.join(contextRoot, "features", "catalog.ts"),
      );
      writeFileSync(path.join(contextRoot, "features", "catalog.ts"), "export const catalog = {};\n");
      expect(findBrowserUnsafeLocalizationReachability({ contextRoot, targetPath: target })).toBeNull();

      rmSync(path.join(contextRoot, "features", "catalog.ts"));
      mkdirSync(path.join(contextRoot, "features", "catalog"), { recursive: true });
      writeFileSync(target, 'export { catalog } from "./features/catalog";\n');
      writeFileSync(
        path.join(contextRoot, "features", "catalog", "index.ts"),
        'export { locales } from "./locales";\n',
      );
      writeFileSync(path.join(contextRoot, "features", "catalog", "locales.ts"), 'import "node:fs";\n');
      expect(findBrowserUnsafeLocalizationReachability({ contextRoot, targetPath: target })).toBe(
        path.join(contextRoot, "features", "catalog", "locales.ts"),
      );
      writeFileSync(path.join(contextRoot, "features", "catalog", "locales.ts"), "export const locales = {};\n");
      expect(findBrowserUnsafeLocalizationReachability({ contextRoot, targetPath: target })).toBeNull();

      writeFileSync(path.join(contextRoot, "features", "catalog", "index.ts"), 'import "./setup";\n');
      writeFileSync(path.join(contextRoot, "features", "catalog", "setup.ts"), 'import "node:fs";\n');
      expect(findBrowserUnsafeLocalizationReachability({ contextRoot, targetPath: target })).toBe(
        path.join(contextRoot, "features", "catalog", "setup.ts"),
      );
    } finally {
      rmSync(contextRoot, { recursive: true, force: true });
    }
  });

  it("admits only the canonical source and feature metadata seams", () => {
    expect(isCanonicalBoundedContextRootFile("context.source.mjs")).toBe(true);
    expect(isCanonicalBoundedContextRootFile("helper.mjs")).toBe(false);
    expect(isAdmittedFeatureMetadataFile("metadata.json")).toBe(true);
    expect(isAdmittedFeatureMetadataFile("helper.mjs")).toBe(false);
  });

  it("makes one-consumer support a violation for source-backed contexts", () => {
    expect(singleSliceSupportSeverity({ sourceBacked: true, enforcementMode: "warn" })).toBe("violation");
    expect(singleSliceSupportSeverity({ sourceBacked: false, enforcementMode: "warn" })).toBe("warn");
    expect(singleSliceSupportSeverity({ sourceBacked: false, enforcementMode: "violation" })).toBe("violation");
  });

  it("rejects route loader and action modules outside route-support", () => {
    expect(
      violationFor(
        "bounded-contexts/catalog/support/shell-support/admin-integrations/integrations-loader.ts",
        "export async function loader() {}",
      ),
    ).toBe(
      "route loader/action modules must live under support/route-support/<route-name>/, not support/shell-support/",
    );

    expect(
      violationFor(
        "bounded-contexts/catalog/support/shell-support/admin-integrations/integrations-action.ts",
        "export const action = async () => null;",
      ),
    ).toBe(
      "route loader/action modules must live under support/route-support/<route-name>/, not support/shell-support/",
    );
  });

  it("allows canonical route-support modules", () => {
    expect(
      violationFor(
        "bounded-contexts/discovery/support/route-support/item-detail/action.ts",
        "export async function action() {}",
      ),
    ).toBeNull();
  });

  it("exempts cross-cutting runtime composition support directories", () => {
    expect(
      violationFor(
        "bounded-contexts/discovery/support/request-support/transport/action.ts",
        "export async function action() {}",
      ),
    ).toBeNull();
  });

  it("allows non-route-helper support modules outside route-support", () => {
    expect(
      violationFor(
        "bounded-contexts/catalog/support/shell-support/ui/realtime-reload-action-bar.tsx",
        "export function CatalogRealtimeReloadActionBar() {}",
      ),
    ).toBeNull();
  });
});
