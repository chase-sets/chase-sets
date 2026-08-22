import { describe, expect, it } from "vitest";
import {
  discoverTrackedShellContributionManifests,
  validateShellContributionEntries,
  validateShellContributionManifests,
} from "./run.mjs";

function route(key, href, overrides = {}) {
  return {
    deployable: "marketplace-web",
    slot: "top-nav",
    key,
    label: `Label ${key}`,
    icon: "box",
    href,
    order: 10,
    visibility: "always",
    requiredPermissions: [],
    ...overrides,
  };
}

function group(key, overrides = {}) {
  return {
    deployable: "marketplace-web",
    slot: "top-nav",
    key,
    label: `Label ${key}`,
    icon: "box",
    order: 10,
    visibility: "always",
    requiredPermissions: [],
    ...overrides,
  };
}

function manifestRecord(root, contextName, shellContributions, routePaths = []) {
  return {
    root,
    manifest: {
      contextName,
      deployableContributions: [
        {
          deployable: "marketplace-web",
          routes: routePaths.map((routePath) => ({ routePath })),
        },
      ],
      shellContributions,
    },
  };
}

function validate(records, options = {}) {
  return validateShellContributionManifests({ manifests: records, ...options });
}

function codes(result) {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

const nestedAdminContribution = {
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
  it("discovers every tracked context manifest by shape and keeps the production surface green", async () => {
    const discovery = await discoverTrackedShellContributionManifests();
    expect(discovery.diagnostics).toEqual([]);
    expect(discovery.surface).toEqual({ scanned: 19, total: 19 });
    expect(validate(discovery.manifests)).toMatchObject({
      diagnostics: [],
      surface: { scanned: 19, total: 19 },
    });
  });

  it("discovers an arbitrary tracked path without consulting a context-name allowlist", async () => {
    const files = new Map([
      ["unfamiliar/deep-space/context.json", JSON.stringify({ contextName: "quasar-garden", shellContributions: [] })],
      ["fixtures/context.json", JSON.stringify({ fixture: true })],
    ]);
    const discovery = await discoverTrackedShellContributionManifests({
      trackedFiles: [...files.keys()],
      readFile: async (file) => files.get(file),
    });

    expect(discovery.surface).toEqual({ scanned: 1, total: 2 });
    expect(discovery.manifests.map((record) => record.root)).toEqual(["unfamiliar/deep-space"]);
  });

  it("accepts same-context nested Admin navigation and validates its route inventory", () => {
    const manifest = {
      contextName: "catalog",
      deployableContributions: [{ deployable: "admin-web", routes: [{ routePath: "integrations/providers" }] }],
      shellContributions: [nestedAdminContribution],
    };
    expect(validateShellContributionEntries({ root: "bounded-contexts/catalog", manifest })).toEqual([]);

    const invalid = validateShellContributionEntries({
      root: "bounded-contexts/catalog",
      manifest: {
        ...manifest,
        deployableContributions: [{ deployable: "admin-web", routes: [{ routePath: "integrations" }] }],
      },
    });
    expect(invalid).toContainEqual({
      code: "SHELL_ROUTE_NOT_OWNED",
      path: "bounded-contexts/catalog/context.json shellContributions[0].children[0]",
      message: "shell contributions must point at a same-context route contribution for the target deployable",
    });
  });

  it("attaches arbitrary-context children by expanded deployable and slot", () => {
    const result = validate([
      manifestRecord("unfamiliar/orbit-owner", "orbit-owner", [group("constellation")]),
      manifestRecord(
        "unfamiliar/comet-member",
        "comet-member",
        [route("comet-tail", "/comets", { parentKey: "constellation" })],
        ["comets"],
      ),
    ]);

    expect(result).toEqual({ diagnostics: [], surface: { scanned: 2, total: 2 } });
  });

  it.each([
    {
      name: "duplicate expanded key",
      expected: "SHELL_DUPLICATE_EXPANDED_KEY",
      records: [
        manifestRecord("unfamiliar/a", "a", [route("nebula", "/a")], ["a"]),
        manifestRecord("unfamiliar/b", "b", [route("nebula", "/b")], ["b"]),
      ],
    },
    {
      name: "duplicate expanded href",
      expected: "SHELL_DUPLICATE_EXPANDED_HREF",
      records: [
        manifestRecord("unfamiliar/a", "a", [route("alpha", "/shared")], ["shared"]),
        manifestRecord("unfamiliar/b", "b", [route("beta", "/shared")], ["shared"]),
      ],
    },
    {
      name: "unknown parent",
      expected: "SHELL_PARENT_MISSING",
      records: [
        manifestRecord(
          "unfamiliar/child",
          "child",
          [route("wandering-moon", "/moon", { parentKey: "unknown-galaxy" })],
          ["moon"],
        ),
      ],
    },
    {
      name: "parent in another expanded slot",
      expected: "SHELL_PARENT_INVALID",
      records: [
        manifestRecord("unfamiliar/parent", "parent", [group("galaxy", { slot: "bottom-nav" })]),
        manifestRecord("unfamiliar/child", "child", [route("moon", "/moon", { parentKey: "galaxy" })], ["moon"]),
      ],
    },
    {
      name: "self parent",
      expected: "SHELL_PARENT_SELF",
      records: [manifestRecord("unfamiliar/self", "self", [group("ouroboros", { parentKey: "ouroboros" })])],
    },
    {
      name: "parent cycle",
      expected: "SHELL_PARENT_CYCLE",
      records: [
        manifestRecord("unfamiliar/cycle", "cycle", [
          group("binary-a", { parentKey: "binary-b" }),
          group("binary-b", { parentKey: "binary-a" }),
        ]),
      ],
    },
    {
      name: "access widening",
      expected: "SHELL_ACCESS_WIDENING",
      records: [
        manifestRecord(
          "unfamiliar/access",
          "access",
          [
            group("private-system", { visibility: "signed-in", requiredPermissions: ["system.view"] }),
            route("public-planet", "/planet", { parentKey: "private-system" }),
          ],
          ["planet"],
        ),
      ],
    },
    {
      name: "malformed action",
      expected: "SHELL_ACTION_MALFORMED",
      records: [
        manifestRecord(
          "unfamiliar/action",
          "action",
          [route("signal", "/signal", { activation: "action" })],
          ["signal"],
        ),
      ],
    },
    {
      name: "non-finite order",
      expected: "SHELL_ORDER_NON_FINITE",
      records: [manifestRecord("unfamiliar/order", "order", [route("nan", "/nan", { order: Number.NaN })], ["nan"])],
    },
    {
      name: "non-finite priority",
      expected: "SHELL_PACKING_PRIORITY_NON_FINITE",
      records: [
        manifestRecord(
          "unfamiliar/priority",
          "priority",
          [route("infinity", "/infinity", { packingPriority: Number.POSITIVE_INFINITY })],
          ["infinity"],
        ),
      ],
    },
    {
      name: "non-finite badge max",
      expected: "SHELL_BADGE_MAX_INVALID",
      records: [
        manifestRecord(
          "unfamiliar/badge",
          "badge",
          [
            route("badge", "/badge", {
              badge: { valueKey: "unfamiliar.badge", max: Number.NaN, hideWhenEmptyForSignedOut: false },
            }),
          ],
          ["badge"],
        ),
      ],
    },
    {
      name: "duplicate badge owner",
      expected: "SHELL_DUPLICATE_BADGE_OWNER",
      records: [
        manifestRecord(
          "unfamiliar/badges",
          "badges",
          [
            route("badge-a", "/a", {
              badge: { valueKey: "unfamiliar.badge", max: 9, hideWhenEmptyForSignedOut: false },
            }),
            route("badge-b", "/b", {
              badge: { valueKey: "unfamiliar.badge", max: 9, hideWhenEmptyForSignedOut: false },
            }),
          ],
          ["a", "b"],
        ),
      ],
    },
    {
      name: "malformed active path",
      expected: "SHELL_ACTIVE_PATH_MALFORMED",
      records: [
        manifestRecord(
          "unfamiliar/path",
          "path",
          [route("path", "/path", { activePathPatterns: ["/path/:id"] })],
          ["path"],
        ),
      ],
    },
    {
      name: "ambiguous active alias",
      expected: "SHELL_ACTIVE_AMBIGUITY",
      records: [
        manifestRecord(
          "unfamiliar/aliases",
          "aliases",
          [
            route("alias-a", "/a", { activePathPatterns: ["/shared-alias"] }),
            route("alias-b", "/b", { activePathPatterns: ["/shared-alias"] }),
          ],
          ["a", "b"],
        ),
      ],
    },
    {
      name: "limited slot missing priority",
      expected: "SHELL_LIMIT_PRIORITY_MISSING",
      records: [
        manifestRecord(
          "unfamiliar/packing",
          "packing",
          [route("packed", "/packed", { packingPriority: 10 }), route("unpacked", "/unpacked")],
          ["packed", "unpacked"],
        ),
      ],
      options: { limitedSlots: ["marketplace-web:top-nav"] },
    },
  ])("fails the $name mutant with a stable code", ({ records, expected, options }) => {
    expect(codes(validate(records, options))).toContain(expected);
  });

  it("requires inline children to carry priority when a limited slot is exercised", () => {
    const records = [
      manifestRecord(
        "unfamiliar/limited-tree",
        "limited-tree",
        [
          group("packed-group", {
            packingPriority: 10,
            children: [
              {
                key: "inline-child",
                label: "Inline child",
                icon: "box",
                href: "/inline",
                order: 10,
                visibility: "always",
                requiredPermissions: [],
              },
            ],
          }),
        ],
        ["inline"],
      ),
    ];

    const result = validate(records, { limitedSlots: ["marketplace-web:top-nav"] });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SHELL_LIMIT_PRIORITY_MISSING", path: expect.stringContaining("children[0]") }),
    );
  });
});
