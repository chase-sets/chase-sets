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
  it.each(["all", "any"])("accepts permission match mode %s on parents and children", (requiredPermissionsMatch) => {
    expect(
      validate([
        {
          ...nestedContribution,
          requiredPermissionsMatch,
          children: nestedContribution.children.map((child) => ({ ...child, requiredPermissionsMatch })),
        },
      ]),
    ).toEqual([]);
  });

  it.each(["some", true, null, 1, ""])(
    "rejects invalid permission match mode %s on each node",
    (requiredPermissionsMatch) => {
      expect(
        validate([
          {
            ...nestedContribution,
            requiredPermissionsMatch,
            children: nestedContribution.children.map((child) => ({ ...child, requiredPermissionsMatch })),
          },
        ]),
      ).toEqual(
        ["", ".children[0]"].map((suffix) => ({
          path: `bounded-contexts/catalog/context.json shellContributions[0]${suffix}`,
          message: "requiredPermissionsMatch must be 'all' or 'any' when provided",
        })),
      );
    },
  );

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
