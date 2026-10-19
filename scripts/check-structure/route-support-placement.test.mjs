import { describe, expect, it } from "vitest";
import { findBrowserUnsafeLocalizationExport, findRouteSupportPlacementViolation, isThinRouteAdapter } from "./run.mjs";

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
    expect(findBrowserUnsafeLocalizationExport('export { loader } from "./server";')).toBe(true);
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
