import { describe, expect, it } from "vitest";
import { validateShellContributionEntries } from "./run.mjs";

function validate(shellContributions, deployableRoutes = ["integrations/providers"]) {
  return validateShellContributionEntries({
    root: "bounded-contexts/catalog",
    manifest: {
      deployableContributions: [
        {
          deployable: "admin-web",
          routes: deployableRoutes.map((routePath) => ({ routePath })),
        },
      ],
      shellContributions,
    },
  });
}

const nestedContribution = {
  deployable: "admin-web",
  slot: "primary-nav",
  key: "integrations",
  label: "Integrations",
  icon: "plug",
  section: "catalog",
  order: 10,
  visibility: "signed-in",
  requiredPermissions: [],
  children: [
    {
      key: "integrations-providers",
      label: "Providers",
      icon: "plug",
      href: "/integrations/providers",
      order: 10,
      visibility: "signed-in",
      requiredPermissions: ["catalog.integrations.manage"],
    },
  ],
};

describe("shell contribution manifest validation", () => {
  it("accepts same-context nested admin navigation children", () => {
    expect(validate([nestedContribution])).toEqual([]);
  });

  it("validates nested children against the same-context route inventory", () => {
    expect(validate([nestedContribution], ["integrations"])).toContainEqual({
      path: "bounded-contexts/catalog/context.json shellContributions[0].children[0]",
      message: "shell contributions must point at a same-context route contribution for the target deployable",
    });
  });
});
