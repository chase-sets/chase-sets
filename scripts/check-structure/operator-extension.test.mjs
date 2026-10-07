import { describe, expect, it } from "vitest";
import { isAllowedDeployableBoundedContextImport } from "./run.mjs";
import { e2eSuiteIdsForChangedFile, e2eSuites } from "../e2e-suites.mjs";
import { releaseQualificationScopeRegistry } from "../release-qualification-scope.mjs";

describe("operator extension enrollment and composition fence", () => {
  it("admits only the Catalog client facade in the new deployable", () => {
    const file = "deployables/tcgplayer-operator-extension/src/background.ts";
    expect(isAllowedDeployableBoundedContextImport(file, "@chase-sets/catalog/client")).toBe(true);
    for (const specifier of ["@chase-sets/catalog/server", "@chase-sets/catalog", "@chase-sets/channels/client"])
      expect(isAllowedDeployableBoundedContextImport(file, specifier)).toBe(false);
    expect(
      isAllowedDeployableBoundedContextImport("deployables/other/src/background.ts", "@chase-sets/catalog/client"),
    ).toBe(false);
  });
  it("registers the complete extension and owned behavior as Chromium/release scope", () => {
    for (const path of [
      "deployables/tcgplayer-operator-extension/src/background.ts",
      "bounded-contexts/catalog/features/operator-session/domain/extension/background.ts",
      "bounded-contexts/catalog/features/operator-session/ui/extension-popup/popup.tsx",
      "contracts/localization/locales/en/catalog/operator-extension.ts",
    ])
      expect(e2eSuiteIdsForChangedFile(path)).toEqual(["tcgplayer_operator_extension"]);
    expect(e2eSuites.filter((suite) => suite.id === "tcgplayer_operator_extension")).toHaveLength(1);
    expect(e2eSuites.find((suite) => suite.id === "tcgplayer_operator_extension").command).toEqual([
      "--filter",
      "@chase-sets/app-tcgplayer-operator-extension",
      "run",
      "test:chromium",
    ]);
    expect(releaseQualificationScopeRegistry.deployables["tcgplayer-operator-extension"]).toBe("runtime");
  });
});
