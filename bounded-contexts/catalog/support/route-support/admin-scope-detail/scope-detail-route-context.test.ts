import { describe, expect, it } from "vitest";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import { scopeDetailCommandHref } from "./scope-detail-route-context";

describe("Scope Detail route context", () => {
  it("keeps job and promotion checkpoints and the import selection on Scope Detail", () => {
    const selection = {
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    };
    const context = {
      ...parseCatalogPrimaryWorkbenchRouteContext(
        `https://admin.example/catalog/integrations?languageCode=en&expansionId=scope_expansion_paldean_fates&${new URLSearchParams(selection)}`,
      ),
      jobId: "sync_1",
      promotionPreviewId: "preview_1",
    };

    const href = scopeDetailCommandHref("scope_expansion_paldean_fates", context);
    const url = new URL(href, "https://admin.example");

    expect(url.pathname).toBe("/catalog/scopes/scope_expansion_paldean_fates");
    expect(url.searchParams.get("jobId")).toBe("sync_1");
    expect(url.searchParams.get("promotionPreviewId")).toBe("preview_1");
    expect(url.searchParams.get("expansionId")).toBe("scope_expansion_paldean_fates");
    for (const [key, value] of Object.entries(selection)) expect(url.searchParams.get(key), key).toBe(value);
  });
});
