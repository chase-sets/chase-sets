import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverShellContributionManifests,
  validateDiscoveredShellContributions,
  validateDeployableShellOwnership,
  validateShellContributionEntries,
} from "./run.mjs";

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
          code: "SHELL_ENTRY_INVALID",
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
      code: "SHELL_ENTRY_INVALID",
    });
  });
});

const repositories = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function trackedRepository(files) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "shell-contributions-"));
  repositories.push(repoRoot);
  execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true });
    await writeFile(path.join(repoRoot, file), typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  execFileSync("git", ["add", "--", ...Object.keys(files)], { cwd: repoRoot, stdio: "pipe" });
  return { repoRoot };
}

const leaf = (key, overrides = {}) => ({
  deployable: "marketplace-web",
  slot: "top-nav",
  key,
  label: key,
  href: `/${key}`,
  icon: "box",
  order: 1,
  visibility: "always",
  requiredPermissions: [],
  ...overrides,
});
const manifest = (shellContributions, routes = ["owned"], deployable = "marketplace-web") => ({
  contextName: "arbitrary",
  deployableContributions: [{ deployable, routes: routes.map((routePath) => ({ routePath })) }],
  shellContributions,
});

describe("shell contribution discovery matrix", () => {
  it("classifies top-level shell shape before diagnosing JSON or JSONC siblings", async () => {
    const files = {
      "arbitrary/array.json": [{ shellContributions: null }],
      "arbitrary/null.json": null,
      "arbitrary/number.json": 42,
      "arbitrary/boolean.json": true,
      "arbitrary/string.json": '"shellContributions"',
      "arbitrary/nested.json": { nested: { shellContributions: null } },
      "arbitrary/malformed.json": '{ "unrelated": ',
      "arbitrary/malformed-text.json": '{ "unrelated": "shellContributions", ',
      "arbitrary/jsonc.json": '{ // Candidate with comments and a trailing comma.\n"shellContributions": [],\n}',
    };
    const options = await trackedRepository(files);
    const discovered = await discoverShellContributionManifests(options);
    expect(discovered.scanned).toBe(Object.keys(files).length);
    expect(discovered.candidates).toBe(1);
    expect(discovered.manifests.map((entry) => entry.manifestPath)).toEqual(["arbitrary/jsonc.json"]);
    expect(discovered.diagnostics).toEqual([]);
    expect(await validateDiscoveredShellContributions(options)).toEqual({
      scanned: Object.keys(files).length,
      candidates: 1,
      diagnostics: [],
    });
  });

  it.each(['{ "shellContributions": ', '{ "shellContributions": [null]', '{ "shellContributions": [], "unrelated": }'])(
    "retains malformed candidate accounting and parse diagnostics for %s",
    async (source) => {
      const files = {
        "unknown/broken.json": source,
        "unknown/valid.json": manifest([]),
        "unknown/unrelated.json": '{ "other": ',
      };
      const options = await trackedRepository(files);
      const discovered = await discoverShellContributionManifests(options);
      const diagnostic = {
        code: "SHELL_MANIFEST_JSON",
        path: "unknown/broken.json",
        message: "shell contribution manifest could not be parsed",
      };
      expect(discovered.scanned).toBe(Object.keys(files).length);
      expect(discovered.candidates).toBe(2);
      expect(discovered.manifests.map((entry) => entry.manifestPath)).toEqual(["unknown/valid.json"]);
      expect(discovered.diagnostics).toEqual([diagnostic]);
      expect(await validateDiscoveredShellContributions(options)).toEqual({
        scanned: Object.keys(files).length,
        candidates: 2,
        diagnostics: [diagnostic],
      });
    },
  );

  it.each([false, true])("unions FIRST-block routes in either order (reversed=%s)", async (reversed) => {
    const candidate = manifest([leaf("owned")]);
    const blocks = [
      ...candidate.deployableContributions,
      { deployable: "marketplace-web", routes: [{ routePath: "second" }] },
    ];
    candidate.deployableContributions = reversed ? blocks.reverse() : blocks;
    const options = await trackedRepository({
      "historic/anything/not-context.json": candidate,
      "unrelated/settings.json": '{ // JSONC is valid repository configuration\n"enabled": true,\n}',
    });
    const result = await validateDiscoveredShellContributions(options);
    expect(result.diagnostics).toEqual([]);
    expect(result.scanned).toBe(2);
    expect(result.candidates).toBe(1);
  });

  it.each(["unowned", "other-host", "other-context"])("does not borrow %s routes", async (kind) => {
    const candidate = manifest([leaf("owned")], []);
    const sibling = manifest([], []);
    if (kind === "other-host")
      candidate.deployableContributions.push({ deployable: "admin-web", routes: [{ routePath: "owned" }] });
    if (kind === "other-context") sibling.deployableContributions[0].routes.push({ routePath: "owned" });
    const options = await trackedRepository({ "old/first.json": candidate, "new/second.json": sibling });
    const result = await validateDiscoveredShellContributions(options);
    expect(result.diagnostics).toContainEqual({
      code: "SHELL_ENTRY_INVALID",
      path: "old/first.json shellContributions[0]",
      message: "shell contributions must point at a same-context route contribution for the target deployable",
    });
    expect(result.candidates).toBe(2);
  });

  it.each([{}, "not-an-array", null])(
    "classifies malformed shell arrays %j without skipping or throwing in either validator",
    async (shellContributions) => {
      const files = {
        "retired/unexpected/declaration.json": manifest(shellContributions),
        "another/unknown.json": manifest([leaf("owned")]),
      };
      const options = await trackedRepository(files);
      const discovered = await discoverShellContributionManifests(options);
      expect(discovered.scanned).toBe(Object.keys(files).length);
      expect(discovered.candidates).toBe(2);
      const expected = {
        code: "SHELL_ARRAY_SHAPE",
        path: "retired/unexpected/declaration.json shellContributions",
        message: "shellContributions must be an array",
      };
      expect(discovered.manifests.flatMap(validateShellContributionEntries)).toContainEqual(expected);
      expect(validateDeployableShellOwnership(discovered.manifests)).toContainEqual(expected);
      expect((await validateDiscoveredShellContributions(options)).diagnostics).toEqual([expected]);
    },
  );

  it.each([
    [[null], "[0]"],
    [[leaf("group", { href: undefined, children: [null] })], "[0].children[0]"],
    [
      [leaf("group", { href: undefined, children: [leaf("inner", { href: undefined, children: [null] })] })],
      "[0].children[0].children[0]",
    ],
  ])("diagnoses null at every tree depth %j", async (nodes, suffix) => {
    const options = await trackedRepository({ "unknown/manifest.json": manifest(nodes) });
    const discovered = await discoverShellContributionManifests(options);
    const expected = {
      code: "SHELL_NODE_SHAPE",
      path: `unknown/manifest.json shellContributions${suffix}`,
      message: "shell contribution must be an object",
    };
    expect(discovered.manifests.flatMap(validateShellContributionEntries)).toContainEqual(expected);
    expect(validateDeployableShellOwnership(discovered.manifests)).toContainEqual(expected);
    expect((await validateDiscoveredShellContributions(options)).diagnostics).toContainEqual(expected);
  });

  it("preserves legacy href groups and empty inline arrays", async () => {
    const options = await trackedRepository({
      "old/manifest.json": manifest(
        [leaf("owned", { children: [leaf("child")] }), leaf("empty", { children: [] })],
        ["owned", "child", "empty"],
      ),
    });
    expect((await validateDiscoveredShellContributions(options)).diagnostics).toEqual([]);
  });

  it("accepts attachment, aliases and badges independently in each expanded slot", async () => {
    const group = leaf("group", { href: undefined, children: [], placements: ["top-nav", "account-menu"] });
    const child = leaf("owned", {
      parentKey: "group",
      placements: ["top-nav", "account-menu"],
      activePathPatterns: ["/alias", "/alias/"],
      packingPriority: 10,
      placement: "utility",
      badge: { valueKey: "count", max: 99, hideWhenEmptyForSignedOut: true },
    });
    const options = await trackedRepository({ "first/x.json": manifest([group]), "second/y.json": manifest([child]) });
    expect((await validateDiscoveredShellContributions(options)).diagnostics).toEqual([]);
  });

  it.each([
    [{ activation: "action" }, "SHELL_ACTION_INVALID"],
    [{ activation: "action", href: undefined, children: [] }, "SHELL_ACTION_INVALID"],
    [{ activation: "action", href: undefined, activePathPatterns: [] }, "SHELL_ACTION_INVALID"],
    [{ activation: "route", href: undefined }, "SHELL_ROUTE_INVALID"],
    [{ activation: "route", children: [] }, "SHELL_ROUTE_INVALID"],
    [{ activation: "unknown" }, "SHELL_ACTIVATION_INVALID"],
    [{ order: null }, "SHELL_ORDER_INVALID"],
    [{ packingPriority: "1" }, "SHELL_PRIORITY_INVALID"],
    [{ placement: "bottom-nav" }, "SHELL_PLACEMENT_INVALID"],
    [{ excludedRoleKeys: null }, "SHELL_ROLES_INVALID"],
    [{ children: {} }, "SHELL_CHILDREN_SHAPE"],
    [{ badge: null }, "SHELL_BADGE_INVALID"],
    [{ badge: { valueKey: "count", max: 0, hideWhenEmptyForSignedOut: true } }, "SHELL_BADGE_INVALID"],
    [{ badge: { valueKey: "count", max: "99", hideWhenEmptyForSignedOut: true } }, "SHELL_BADGE_INVALID"],
    [{ badge: { valueKey: "count", max: 99, hideWhenEmptyForSignedOut: "true" } }, "SHELL_BADGE_INVALID"],
    [{ activePathPatterns: [null] }, "SHELL_ACTIVE_PATH_INVALID"],
    [{ activePathPatterns: ["/owned?query"] }, "SHELL_ACTIVE_PATH_INVALID"],
    [{ activePathPatterns: ["/owned#hash"] }, "SHELL_ACTIVE_PATH_INVALID"],
    [{ activePathPatterns: ["/owned/*"] }, "SHELL_ACTIVE_PATH_INVALID"],
    [{ activePathPatterns: ["/owned/:id"] }, "SHELL_ACTIVE_PATH_INVALID"],
    [{ parentKey: 42 }, "SHELL_PARENT_INVALID"],
  ])("discovers and rejects malformed field %j", async (overrides, code) => {
    const options = await trackedRepository({ "anywhere/anything.json": manifest([leaf("owned", overrides)]) });
    expect((await validateDiscoveredShellContributions(options)).diagnostics).toContainEqual(
      expect.objectContaining({ code, path: "anywhere/anything.json shellContributions[0]" }),
    );
  });

  it.each([
    [[leaf("owned"), leaf("owned")], "SHELL_DUPLICATE_KEY"],
    [[leaf("owned"), leaf("other", { href: "/owned/" })], "SHELL_DUPLICATE_HREF"],
    [[leaf("owned", { placements: ["top-nav", "top-nav"] })], "SHELL_DUPLICATE_KEY"],
    [
      [leaf("owned", { activePathPatterns: ["/alias"] }), leaf("other", { activePathPatterns: ["/alias/"] })],
      "SHELL_ACTIVE_PATH_AMBIGUOUS",
    ],
    [
      [
        leaf("owned", { badge: { valueKey: "count", max: 99, hideWhenEmptyForSignedOut: true } }),
        leaf("other", { badge: { valueKey: "count", max: 99, hideWhenEmptyForSignedOut: true } }),
      ],
      "SHELL_DUPLICATE_BADGE",
    ],
    [[leaf("owned", { parentKey: "absent" })], "SHELL_PARENT_MISSING"],
    [[leaf("owned", { parentKey: "owned" })], "SHELL_PARENT_SELF"],
    [[leaf("owned"), leaf("other", { parentKey: "owned" })], "SHELL_PARENT_INVALID"],
    [
      [
        leaf("owned", { href: undefined, children: [], parentKey: "other" }),
        leaf("other", { href: undefined, children: [], parentKey: "owned" }),
      ],
      "SHELL_PARENT_CYCLE",
    ],
    [
      [
        leaf("owned", { href: undefined, children: [], visibility: "signed-in" }),
        leaf("other", { parentKey: "owned" }),
      ],
      "SHELL_PARENT_WIDENING",
    ],
    [
      [
        leaf("owned", { href: undefined, children: [], excludedRoleKeys: ["blocked"] }),
        leaf("other", { parentKey: "owned" }),
      ],
      "SHELL_PARENT_WIDENING",
    ],
    [
      [leaf("owned", { href: undefined, children: [], slot: "account-menu" }), leaf("other", { parentKey: "owned" })],
      "SHELL_PARENT_MISSING",
    ],
  ])("validates expanded ownership mutant %j", async (nodes, code) => {
    const options = await trackedRepository({ "different/place.json": manifest(nodes, ["owned", "other", "owned/"]) });
    expect((await validateDiscoveredShellContributions(options)).diagnostics).toContainEqual(
      expect.objectContaining({ code }),
    );
  });

  it("expands Admin sections before href and active ambiguity checks and rejects cross-section parents", async () => {
    const admin = (key, section, overrides = {}) =>
      leaf(key, {
        deployable: "admin-web",
        slot: "primary-nav",
        section,
        href: "/owned",
        activePathPatterns: ["/alias"],
        ...overrides,
      });
    const files = {
      "first/a.json": manifest([admin("one", "catalog")], ["owned"], "admin-web"),
      "second/b.json": manifest([admin("two", "commerce")], ["owned"], "admin-web"),
    };
    expect((await validateDiscoveredShellContributions(await trackedRepository(files))).diagnostics).toEqual([]);
    const options = await trackedRepository({
      "first/a.json": manifest(
        [
          admin("group", "catalog", { href: undefined, activePathPatterns: undefined, children: [] }),
          admin("child", "commerce", { parentKey: "group" }),
        ],
        ["owned"],
        "admin-web",
      ),
    });
    expect((await validateDiscoveredShellContributions(options)).diagnostics).toContainEqual(
      expect.objectContaining({ code: "SHELL_PARENT_SECTION" }),
    );
  });

  it("restricts account-menu to Marketplace without filtering arbitrary owners", async () => {
    const options = await trackedRepository({
      "unlisted/owner.json": manifest(
        [leaf("owned", { deployable: "admin-web", slot: "account-menu", section: "catalog" })],
        ["owned"],
        "admin-web",
      ),
    });
    expect((await validateDiscoveredShellContributions(options)).diagnostics).toContainEqual(
      expect.objectContaining({ message: "slot must be one of primary-nav" }),
    );
  });

  it("handles non-finite JSON numbers and retains unrelated diagnostics", async () => {
    const text = JSON.stringify(
      manifest([
        leaf("owned", {
          order: "OVERFLOW",
          packingPriority: "OVERFLOW",
          badge: { valueKey: "count", max: "OVERFLOW", hideWhenEmptyForSignedOut: true },
          requiredPermissionsMatch: "some",
        }),
      ]),
    ).replaceAll('"OVERFLOW"', "1e999");
    const result = await validateDiscoveredShellContributions(
      await trackedRepository({ "unknown/overflow.json": text }),
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "SHELL_ORDER_INVALID",
        "SHELL_PRIORITY_INVALID",
        "SHELL_BADGE_INVALID",
        "SHELL_ENTRY_INVALID",
      ]),
    );
  });

  it.each([
    ["all", ["a", "b"], "all", ["a", "b", "c"], false],
    ["all", ["a", "b"], "any", ["a", "b"], true],
    ["any", ["a", "b"], "any", ["a"], false],
    ["any", ["a", "b"], "all", ["b", "c"], false],
    ["any", ["a", "b"], "any", ["a", "c"], true],
    ["all", [], "any", [], false],
    ["all", ["a"], "all", [], true],
  ])(
    "checks discovered parent permission implication %s %j -> %s %j",
    async (parentMatch, parentPermissions, childMatch, childPermissions, widens) => {
      const options = await trackedRepository({
        "arbitrary/access.json": manifest([
          leaf("group", {
            href: undefined,
            children: [],
            requiredPermissionsMatch: parentMatch,
            requiredPermissions: parentPermissions,
          }),
          leaf("owned", {
            parentKey: "group",
            requiredPermissionsMatch: childMatch,
            requiredPermissions: childPermissions,
          }),
        ]),
      });
      const result = await validateDiscoveredShellContributions(options);
      if (widens) expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SHELL_PARENT_WIDENING" }));
      else expect(result.diagnostics).toEqual([]);
    },
  );
});
