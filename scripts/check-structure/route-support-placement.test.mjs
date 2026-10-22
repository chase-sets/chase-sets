import { describe, expect, it } from "vitest";
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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    expect(isAdmittedFeatureMetadataFile("REMOVAL.md")).toBe(true);
    expect(isAdmittedFeatureMetadataFile("removal.md")).toBe(false);
    expect(isAdmittedFeatureMetadataFile("arbitrary.md")).toBe(false);
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
