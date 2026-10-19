import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_INVENTORY_PATH,
  checkCredentialInventory,
  checkInventoryAgainstWorkflowSources,
  credentialTiers,
  validateCredentialInventory,
} from "./credential-inventory.mjs";

const repositoryInventory = JSON.parse(readFileSync(resolve(CREDENTIAL_INVENTORY_PATH), "utf8"));

function entry(name, overrides = {}) {
  return {
    name,
    scope: ["staging", "production"],
    kind: "credential",
    rotation: "assisted",
    providerExpiryDays: null,
    maxAgeDays: 365,
    liveness: null,
    pairedWith: [],
    proofWorkflows: [],
    ...overrides,
  };
}

function fixture(secrets) {
  return { schemaVersion: 1, environments: ["production", "staging"], secrets };
}

function validFixture() {
  const { inventory, errors } = validateCredentialInventory(
    fixture([
      entry("ALPHA_TOKEN", { proofWorkflows: ["deploy.yml"] }),
      entry("SPACES_ACCESS_ID", { liveness: { kind: "spaces-list-buckets" }, pairedWith: ["SPACES_SECRET_KEY"] }),
      entry("SPACES_SECRET_KEY", { pairedWith: ["SPACES_ACCESS_ID"] }),
      entry("UNSET_SIGNING_KEY", { optional: true }),
    ]),
  );
  expect(errors).toEqual([]);
  return inventory;
}

function workflow(body) {
  return { file: ".github/workflows/deploy.yml", source: body };
}

const referencingAll = workflow(
  [
    "env:",
    "  A: ${{ secrets.ALPHA_TOKEN }}",
    "  B: ${{ secrets.SPACES_ACCESS_ID }}",
    "  C: ${{ secrets.SPACES_SECRET_KEY }}",
    "  D: ${{ secrets.UNSET_SIGNING_KEY }}",
  ].join("\n"),
);

describe("credential inventory check (AC1)", () => {
  it("passes on the repository inventory, workflows and actions", () => {
    expect(checkCredentialInventory(resolve("."))).toEqual([]);
    const { inventory } = validateCredentialInventory(repositoryInventory);
    expect(inventory.entries.filter((candidate) => candidate.optional)).toHaveLength(11);
  });

  it("names a referenced secret that has no entry", () => {
    const errors = checkInventoryAgainstWorkflowSources(validFixture(), [
      referencingAll,
      { file: ".github/actions/example/action.yml", source: "token: ${{ secrets.NEW_THING }}" },
    ]);
    expect(errors).toEqual([
      "NEW_THING: referenced by .github/actions/example/action.yml but has no credential inventory entry",
    ]);
  });

  it.each(["secrets['X']", 'secrets["X"]', "secrets [ 'X' ]", "secrets[format('{0}', inputs.name)]"])(
    "rejects index syntax %s",
    (expression) => {
      const errors = checkInventoryAgainstWorkflowSources(validFixture(), [
        referencingAll,
        workflow(`run: echo "\${{ ${expression} }}"`),
      ]);
      expect(errors).toEqual([".github/workflows/deploy.yml:1: secrets[...] index syntax is not allowed"]);
    },
  );

  it("does not read step ids or GITHUB_TOKEN as inventory names", () => {
    const errors = checkInventoryAgainstWorkflowSources(validFixture(), [
      referencingAll,
      workflow(
        "a: ${{ steps.runtime_secrets.outcome }}\nb: ${{ steps.secrets.outputs.value }}\nc: ${{ secrets.GITHUB_TOKEN }}",
      ),
    ]);
    expect(errors).toEqual([]);
  });

  it("requires proof workflows and optional names to be real references", () => {
    const errors = checkInventoryAgainstWorkflowSources(validFixture(), [
      workflow("env:\n  B: ${{ secrets.SPACES_ACCESS_ID }}\n  C: ${{ secrets.SPACES_SECRET_KEY }}"),
    ]);
    expect(errors).toEqual([
      "ALPHA_TOKEN: proof workflow deploy.yml does not reference this secret",
      "UNSET_SIGNING_KEY: optional entries are for referenced names, but no workflow references it",
    ]);
  });

  it("rejects overlapping valueGroups and groups that do not cover scope", () => {
    const overlap = validateCredentialInventory(
      fixture([entry("ALPHA_TOKEN", { valueGroups: [["staging", "production"], ["production"]] })]),
    );
    expect(overlap.errors).toEqual(["ALPHA_TOKEN: valueGroups must partition scope without overlap"]);
    const partial = validateCredentialInventory(fixture([entry("ALPHA_TOKEN", { valueGroups: [["staging"]] })]));
    expect(partial.errors).toEqual(["ALPHA_TOKEN: valueGroups must partition scope without overlap"]);
  });

  it("defaults to one value group per scope member", () => {
    const { inventory } = validateCredentialInventory(fixture([entry("ALPHA_TOKEN")]));
    expect(inventory.byName.get("ALPHA_TOKEN").valueGroups).toEqual([["staging"], ["production"]]);
    expect(inventory.scopes).toEqual(["repository", "production", "staging"]);
  });

  it.each([
    ["an unknown key", { secret: "value" }, "ALPHA_TOKEN: unknown key secret"],
    ["an unknown kind", { kind: "password" }, "ALPHA_TOKEN: kind must be credential or identifier"],
    [
      "an unknown rotation",
      { rotation: "manual" },
      "ALPHA_TOKEN: rotation must be automatic, assisted or external-owner",
    ],
    [
      "external-owner without an owner",
      { rotation: "external-owner" },
      "ALPHA_TOKEN: owner issue is required for external-owner rotation and only there",
    ],
    [
      "an owner on an assisted entry",
      { owner: 8447 },
      "ALPHA_TOKEN: owner issue is required for external-owner rotation and only there",
    ],
    ["an assisted age other than 365", { maxAgeDays: 90 }, "ALPHA_TOKEN: assisted credentials use maxAgeDays 365"],
    ["a credential without an age limit", { maxAgeDays: null }, "ALPHA_TOKEN: credentials need maxAgeDays"],
    [
      "an identifier with an age limit",
      { kind: "identifier" },
      "ALPHA_TOKEN: identifier entries carry no age limit or provider expiry",
    ],
    [
      "a fractional provider expiry",
      { providerExpiryDays: 1.5 },
      "ALPHA_TOKEN: providerExpiryDays must be a positive integer or null",
    ],
    [
      "an unknown liveness kind",
      { liveness: { kind: "stripe-account" } },
      "ALPHA_TOKEN: liveness must be null or { kind, bucket? } with a known kind",
    ],
    [
      "a bucket on a non-bucket check",
      { liveness: { kind: "digitalocean-account", bucket: "evidence-bucket" } },
      "ALPHA_TOKEN: liveness bucket is required for spaces-bucket and only there",
    ],
    [
      "an uninventoried environment",
      { scope: ["staging", "qa"] },
      'ALPHA_TOKEN: scope must be "repository" or a list of inventoried environments',
    ],
    ["a self pairing", { pairedWith: ["ALPHA_TOKEN"] }, "ALPHA_TOKEN: pairedWith must list other secret names"],
    [
      "a non-workflow proof",
      { proofWorkflows: ["deploy.sh"] },
      "ALPHA_TOKEN: proofWorkflows must list workflow file names",
    ],
    ["optional false", { optional: false }, "ALPHA_TOKEN: optional may only be true"],
  ])("rejects a malformed entry with %s", (_label, overrides, message) => {
    expect(validateCredentialInventory(fixture([entry("ALPHA_TOKEN", overrides)])).errors).toEqual([message]);
  });

  it("rejects duplicate, unsorted and unreciprocated entries", () => {
    expect(validateCredentialInventory(fixture([entry("B_TOKEN"), entry("A_TOKEN")])).errors).toEqual([
      "A_TOKEN: entries must be sorted by name",
    ]);
    expect(validateCredentialInventory(fixture([entry("A_TOKEN"), entry("A_TOKEN")])).errors).toEqual([
      "A_TOKEN: duplicate entry",
      "A_TOKEN: entries must be sorted by name",
    ]);
    expect(
      validateCredentialInventory(fixture([entry("A_TOKEN", { pairedWith: ["B_TOKEN"] }), entry("B_TOKEN")])).errors,
    ).toEqual(["A_TOKEN: pairedWith B_TOKEN is not reciprocated"]);
  });

  it("requires a bucket for a scoped Spaces check", () => {
    const errors = validateCredentialInventory(
      fixture([
        entry("SPACES_ACCESS_ID", { liveness: { kind: "spaces-bucket" }, pairedWith: ["SPACES_SECRET_KEY"] }),
        entry("SPACES_SECRET_KEY", { pairedWith: ["SPACES_ACCESS_ID"] }),
      ]),
    ).errors;
    expect(errors).toEqual(["SPACES_ACCESS_ID: liveness bucket is required for spaces-bucket and only there"]);
  });

  it("requires a Spaces liveness entry to pair with exactly one same-scope secret key", () => {
    const errors = validateCredentialInventory(
      fixture([
        entry("SPACES_ACCESS_ID", { liveness: { kind: "spaces-list-buckets" }, pairedWith: ["SPACES_SECRET_KEY"] }),
        entry("SPACES_SECRET_KEY", { scope: ["staging"], pairedWith: ["SPACES_ACCESS_ID"] }),
      ]),
    ).errors;
    expect(errors).toEqual([
      "SPACES_ACCESS_ID: Spaces liveness partner SPACES_SECRET_KEY must share its scope and carry no liveness",
    ]);
  });

  it("accepts repository scope alone or beside environments", () => {
    const { errors } = validateCredentialInventory(
      fixture([entry("A_TOKEN", { scope: "repository" }), entry("B_URL", { scope: ["repository", "staging"] })]),
    );
    expect(errors).toEqual([]);
  });
});

const byName = (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

function spacesPair(prefix, bucket, scope) {
  return [
    entry(`${prefix}_ACCESS_ID`, {
      scope,
      liveness: { kind: "spaces-bucket", bucket },
      pairedWith: [`${prefix}_SECRET_KEY`],
    }),
    entry(`${prefix}_SECRET_KEY`, { scope, pairedWith: [`${prefix}_ACCESS_ID`] }),
  ];
}

// Every exclusion class the agent tier refuses, beside the classes it admits.
const tierSecrets = [
  entry("DIGITALOCEAN_ACCESS_TOKEN", { liveness: { kind: "digitalocean-account" } }),
  entry("EASYPOST_API_KEY"),
  entry("PARTNER_SESSION_COOKIE", { rotation: "external-owner", owner: 8447 }),
  entry("PLATFORM_ADMIN_PASSWORD"),
  ...spacesPair("PRODUCTION_SPACES", "shared-bucket", ["production"]),
  ...spacesPair("REPOSITORY_SPACES", "repository-bucket", "repository"),
  ...spacesPair("SEED_SPACES", "cs-dev-seed-packs", ["staging"]),
  ...spacesPair("SHARED_SPACES", "shared-bucket", ["staging"]),
  entry("SES_AWS_ACCESS_KEY_ID"),
  entry("SPACES_ACCESS_ID", { liveness: { kind: "spaces-list-buckets" }, pairedWith: ["SPACES_SECRET_KEY"] }),
  entry("SPACES_SECRET_KEY", { pairedWith: ["SPACES_ACCESS_ID"] }),
  entry("STRIPE_PUBLISHABLE_KEY", { pairedWith: ["STRIPE_SECRET_KEY"] }),
  entry("STRIPE_SECRET_KEY", { pairedWith: ["STRIPE_PUBLISHABLE_KEY"] }),
  entry("TCGPLAYER_AUTOMATION_TOKEN"),
].sort(byName);

const admittedKeys = [
  { name: "EASYPOST_API_KEY", testPrefixes: ["EZTK"] },
  { name: "SEED_SPACES_ACCESS_ID", testPrefixes: [] },
  { name: "SEED_SPACES_SECRET_KEY", testPrefixes: [] },
  { name: "STRIPE_PUBLISHABLE_KEY", testPrefixes: ["pk_test_"] },
  { name: "STRIPE_SECRET_KEY", testPrefixes: ["sk_test_", "rk_test_"] },
];

function tierFixture(keys, agentTier = {}) {
  return { ...fixture(tierSecrets), agentTier: { project: "chase-sets-agent-dev", keys, ...agentTier } };
}

function withKeys(...added) {
  return [...admittedKeys, ...added.map((name) => ({ name, testPrefixes: [] }))].sort(byName);
}

function replacing(name, testPrefixes) {
  return admittedKeys.map((key) => (key.name === name ? { name, testPrefixes } : key));
}

describe("agent tier in the credential inventory (AC1)", () => {
  it("admits the repository's agent tier exactly as #10031 ruled", () => {
    const { errors, inventory } = validateCredentialInventory(repositoryInventory);
    expect(errors).toEqual([]);
    expect(inventory.agentTier).toEqual({
      project: "chase-sets-agent-dev",
      keys: [
        { name: "EASYPOST_API_KEY", testPrefixes: ["EZTK"] },
        { name: "SEED_PACKS_SPACES_ACCESS_ID", testPrefixes: [] },
        { name: "SEED_PACKS_SPACES_SECRET_KEY", testPrefixes: [] },
        { name: "STRIPE_PUBLISHABLE_KEY", testPrefixes: ["pk_test_"] },
        { name: "STRIPE_SECRET_KEY", testPrefixes: ["sk_test_", "rk_test_"] },
      ],
    });
  });

  it("admits test keys, a non-production bucket-scoped Spaces pair and an absent agentTier", () => {
    expect(validateCredentialInventory(tierFixture(admittedKeys)).errors).toEqual([]);
    expect(validateCredentialInventory(fixture(tierSecrets)).inventory.agentTier).toBeNull();
  });

  it.each([
    [
      "DIGITALOCEAN_ACCESS_TOKEN",
      withKeys("DIGITALOCEAN_ACCESS_TOKEN"),
      [
        "agentTier DIGITALOCEAN_ACCESS_TOKEN: DIGITALOCEAN_, SES_, TCGPLAYER_ and ADMIN_PASSWORD names are CI/deploy-only",
        "agentTier DIGITALOCEAN_ACCESS_TOKEN: digitalocean-account liveness reaches a whole account, so it is CI/deploy-only",
      ],
    ],
    [
      "the root SPACES_ACCESS_ID",
      withKeys("SPACES_ACCESS_ID"),
      [
        "agentTier SPACES_ACCESS_ID: spaces-list-buckets liveness reaches a whole account, so it is CI/deploy-only",
        "agentTier SPACES_ACCESS_ID: pairedWith SPACES_SECRET_KEY is not in the agent tier",
        "agentTier SPACES_ACCESS_ID: Spaces pair SPACES_ACCESS_ID has a production or repository scope",
      ],
    ],
    [
      "a spaces-bucket pair whose bucket a production-scoped entry uses",
      withKeys("SHARED_SPACES_ACCESS_ID", "SHARED_SPACES_SECRET_KEY"),
      [
        "agentTier SHARED_SPACES_ACCESS_ID: bucket shared-bucket is also used by production-scoped PRODUCTION_SPACES_ACCESS_ID",
        "agentTier SHARED_SPACES_SECRET_KEY: bucket shared-bucket is also used by production-scoped PRODUCTION_SPACES_ACCESS_ID",
      ],
    ],
    [
      "a spaces-bucket pair scoped to production",
      withKeys("PRODUCTION_SPACES_ACCESS_ID", "PRODUCTION_SPACES_SECRET_KEY"),
      [
        "agentTier PRODUCTION_SPACES_ACCESS_ID: Spaces pair PRODUCTION_SPACES_ACCESS_ID has a production or repository scope",
        "agentTier PRODUCTION_SPACES_SECRET_KEY: Spaces pair PRODUCTION_SPACES_ACCESS_ID has a production or repository scope",
      ],
    ],
    [
      "a repository-scoped spaces-bucket pair, which production jobs can read",
      withKeys("REPOSITORY_SPACES_ACCESS_ID", "REPOSITORY_SPACES_SECRET_KEY"),
      [
        "agentTier REPOSITORY_SPACES_ACCESS_ID: Spaces pair REPOSITORY_SPACES_ACCESS_ID has a production or repository scope",
        "agentTier REPOSITORY_SPACES_SECRET_KEY: Spaces pair REPOSITORY_SPACES_ACCESS_ID has a production or repository scope",
      ],
    ],
    [
      "an unknown name",
      withKeys("NOT_INVENTORIED_KEY"),
      ["agentTier NOT_INVENTORIED_KEY: has no credential inventory entry"],
    ],
    [
      "a missing pairedWith partner",
      admittedKeys.filter((key) => key.name !== "STRIPE_PUBLISHABLE_KEY"),
      ["agentTier STRIPE_SECRET_KEY: pairedWith STRIPE_PUBLISHABLE_KEY is not in the agent tier"],
    ],
    [
      "half of a Spaces pair",
      admittedKeys.filter((key) => key.name !== "SEED_SPACES_SECRET_KEY"),
      ["agentTier SEED_SPACES_ACCESS_ID: pairedWith SEED_SPACES_SECRET_KEY is not in the agent tier"],
    ],
    [
      "Stripe secret-key prefixes that drop rk_test_",
      replacing("STRIPE_SECRET_KEY", ["sk_test_"]),
      ["agentTier STRIPE_SECRET_KEY: testPrefixes must be sk_test_, rk_test_ from STRIPE_KEY_CASES"],
    ],
    [
      "Stripe publishable prefixes that add pk_live_",
      replacing("STRIPE_PUBLISHABLE_KEY", ["pk_test_", "pk_live_"]),
      ["agentTier STRIPE_PUBLISHABLE_KEY: testPrefixes must be pk_test_ from STRIPE_KEY_CASES"],
    ],
    [
      "an SES name",
      withKeys("SES_AWS_ACCESS_KEY_ID"),
      ["agentTier SES_AWS_ACCESS_KEY_ID: DIGITALOCEAN_, SES_, TCGPLAYER_ and ADMIN_PASSWORD names are CI/deploy-only"],
    ],
    [
      "a TCGplayer name",
      withKeys("TCGPLAYER_AUTOMATION_TOKEN"),
      [
        "agentTier TCGPLAYER_AUTOMATION_TOKEN: DIGITALOCEAN_, SES_, TCGPLAYER_ and ADMIN_PASSWORD names are CI/deploy-only",
      ],
    ],
    [
      "an admin password",
      withKeys("PLATFORM_ADMIN_PASSWORD"),
      [
        "agentTier PLATFORM_ADMIN_PASSWORD: DIGITALOCEAN_, SES_, TCGPLAYER_ and ADMIN_PASSWORD names are CI/deploy-only",
      ],
    ],
    [
      "an external-owner entry",
      withKeys("PARTNER_SESSION_COOKIE"),
      ["agentTier PARTNER_SESSION_COOKIE: external-owner entries are CI/deploy-only"],
    ],
  ])("rejects %s by name", (_label, keys, messages) => {
    expect(validateCredentialInventory(tierFixture(keys)).errors).toEqual(messages);
  });

  it.each([
    ["a non-object agentTier", { agentTier: [] }, ["agentTier must be an object with project and keys"]],
    ["a missing project", { agentTier: { keys: admittedKeys } }, ["agentTier must be an object with project and keys"]],
    [
      "an unknown agentTier field",
      { agentTier: { project: "chase-sets-agent-dev", keys: admittedKeys, values: {} } },
      ["agentTier: unknown key values"],
    ],
    [
      "an unknown key field",
      { keys: [{ ...admittedKeys[0], value: "x" }, ...admittedKeys.slice(1)] },
      ["agentTier EASYPOST_API_KEY: unknown key value"],
    ],
    [
      "an empty test prefix",
      { keys: replacing("EASYPOST_API_KEY", [""]) },
      ["agentTier EASYPOST_API_KEY: testPrefixes must list unique printable prefixes"],
    ],
    [
      "a duplicate key",
      { keys: [admittedKeys[0], ...admittedKeys] },
      ["agentTier EASYPOST_API_KEY: duplicate key", "agentTier EASYPOST_API_KEY: keys must be sorted by name"],
    ],
    [
      "unsorted keys",
      { keys: [...admittedKeys].reverse() },
      [
        "agentTier STRIPE_PUBLISHABLE_KEY: keys must be sorted by name",
        "agentTier SEED_SPACES_SECRET_KEY: keys must be sorted by name",
        "agentTier SEED_SPACES_ACCESS_ID: keys must be sorted by name",
        "agentTier EASYPOST_API_KEY: keys must be sorted by name",
      ],
    ],
  ])("rejects a malformed agentTier with %s", (_label, override, messages) => {
    const value = { ...tierFixture(admittedKeys), ...("agentTier" in override ? override : {}) };
    if (override.keys) value.agentTier = { ...value.agentTier, keys: override.keys };
    expect(validateCredentialInventory(value).errors).toEqual(messages);
  });
});

describe("credential tiers CLI (AC2)", () => {
  it("partitions every inventory name between the agent tier and CI/deploy-only", () => {
    const { inventory } = validateCredentialInventory(tierFixture(admittedKeys));
    const tiers = credentialTiers(inventory);
    expect(tiers.agent).toEqual(admittedKeys.map((key) => key.name));
    expect([...tiers.agent, ...tiers.ciDeployOnly].sort()).toEqual(tierSecrets.map((secret) => secret.name).sort());
    expect(tiers.ciDeployOnly).toContain("DIGITALOCEAN_ACCESS_TOKEN");
    expect(credentialTiers(validateCredentialInventory(fixture(tierSecrets)).inventory).agent).toEqual([]);
  });

  it("prints every repository inventory name exactly once, and nothing but names under the two headings", () => {
    const result = spawnSync(process.execPath, ["scripts/credential-inventory.mjs", "tiers"], {
      cwd: resolve("."),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.split("\n").filter(Boolean);
    const headings = lines.filter((line) => !/^ {2}[A-Z_][A-Z0-9_]*$/.test(line));
    expect(headings).toEqual([
      "Agent tier (Bitwarden project chase-sets-agent-dev), 5 names:",
      `CI/deploy-only, ${repositoryInventory.secrets.length - 5} names:`,
    ]);
    const printed = lines.filter((line) => !headings.includes(line)).map((line) => line.trim());
    const names = repositoryInventory.secrets.map((secret) => secret.name);
    expect(printed).toHaveLength(names.length);
    expect([...printed].sort()).toEqual([...names].sort());
    const agentHeading = lines.indexOf(headings[0]);
    const ciHeading = lines.indexOf(headings[1]);
    expect(lines.slice(agentHeading + 1, ciHeading).map((line) => line.trim())).toEqual(
      repositoryInventory.agentTier.keys.map((key) => key.name),
    );
  });

  it("refuses an unknown subcommand with usage", () => {
    const result = spawnSync(process.execPath, ["scripts/credential-inventory.mjs", "values"], {
      cwd: resolve("."),
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("usage: credential-inventory.mjs tiers\n");
  });
});
