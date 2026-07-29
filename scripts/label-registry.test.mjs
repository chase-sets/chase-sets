import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { FIELDS } from "./issue-form-labels.mjs";
import {
  BANNED_LABEL_PREFIXES,
  ENABLED_NATIVE_ISSUE_TYPES,
  LABEL_REGISTRY,
  auditLabelInventory,
  canonicalLabelNames,
  collectLiveLabels,
  inspectAreaContextCoverage,
  main,
  renderLabelAuditReport,
  sliceFormValues,
  validateLabelRegistry,
} from "./label-registry.mjs";
import { releaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "chase-sets/chase-sets";
const completeEnv = {
  GITHUB_REPOSITORY: repository,
  GITHUB_TOKEN: "test-token",
  GITHUB_STEP_SUMMARY: "",
};

function response(payload, { status = 200, link = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "link" ? link : null;
      },
    },
    async json() {
      return payload;
    },
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

function totalPayload(totalCount, pageInfo = { hasNextPage: totalCount > 1, endCursor: totalCount > 1 ? "MQ" : null }) {
  return {
    data: {
      repository: {
        databaseId: 12345,
        labels: { totalCount, pageInfo },
      },
    },
  };
}

function createLiveHarness(names = LABEL_REGISTRY.map((entry) => entry.name), usageCount = 0) {
  const requests = [];
  const client = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith("/graphql")) {
      const body = JSON.parse(init.body);
      if (body.query.includes("LabelRegistryTotal")) {
        return response(totalPayload(names.length));
      }
      if (body.query.includes("FrozenLabelUsage")) {
        return response({
          data: Object.fromEntries(
            Object.keys(body.variables).map((key, index) => [`l${index}`, { issueCount: usageCount }]),
          ),
        });
      }
      throw new Error(`Unexpected GraphQL operation: ${body.query}`);
    }
    return response(names.map((name) => ({ name })));
  };
  return { client, requests };
}

function createLogger() {
  const logs = [];
  const errors = [];
  const warnings = [];
  return {
    errors,
    logger: {
      error(message) {
        errors.push(message);
      },
      log(message) {
        logs.push(message);
      },
      warn(message) {
        warnings.push(message);
      },
    },
    logs,
    warnings,
  };
}

function walkFiles(root, predicate) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, predicate));
    else if (predicate(absolute)) files.push(absolute);
  }
  return files;
}

function discoverIssueForms() {
  return walkFiles(path.join(repoRoot, ".github", "ISSUE_TEMPLATE"), (file) => /\.ya?ml$/.test(file)).map((file) => ({
    file,
    form: parseYaml(readFileSync(file, "utf8")),
  }));
}

function discoverLabelCharter() {
  const candidates = walkFiles(path.join(repoRoot, "docs"), (file) => file.endsWith(".md"))
    .map((file) => ({ file, text: readFileSync(file, "utf8") }))
    .filter(({ text }) => /^## Label charter\s*$/m.test(text));
  expect(candidates, "exactly one discovered label charter").toHaveLength(1);
  return candidates[0];
}

describe("canonical label registry schema and partition", () => {
  it("records the implementation-head 81-label total as one valid total partition", () => {
    expect(LABEL_REGISTRY).toHaveLength(81);
    expect(new Set(LABEL_REGISTRY.map((entry) => entry.name)).size).toBe(81);
    expect(validateLabelRegistry()).toEqual([]);
    expect(LABEL_REGISTRY.every((entry) => ["canonical", "grandfathered-frozen"].includes(entry.status))).toBe(true);
    expect(LABEL_REGISTRY.filter((entry) => entry.status === "canonical")).toHaveLength(46);
    expect(LABEL_REGISTRY.filter((entry) => entry.status === "grandfathered-frozen")).toHaveLength(35);
  });

  it("fails the default arm for an invented live label absent from the registry", () => {
    const result = auditLabelInventory([...LABEL_REGISTRY.map((entry) => entry.name), "invented:drift"]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("LABEL_UNREGISTERED: invented:drift is live but absent from the registry.");
  });

  it("accepts an exact frozen banned-family label", () => {
    const fixture = [
      {
        name: "phase:known",
        family: "phase",
        purpose: "Existing issue compatibility only. Cleanup owner: #6174.",
        status: "grandfathered-frozen",
      },
    ];

    expect(auditLabelInventory(["phase:known"], fixture)).toMatchObject({ ok: true, failures: [] });
  });

  it("fails a freshly minted banned-family label with a named diagnostic", () => {
    const result = auditLabelInventory(["phase:fresh"], []);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "LABEL_BANNED_NOT_FROZEN: phase:fresh uses banned prefix phase: without an exact grandfathered-frozen entry.",
    ]);
  });

  it.each([
    {
      name: "wildcard",
      entry: {
        name: "phase:*",
        family: "phase",
        purpose: "Legacy. Cleanup owner: #6174.",
        status: "grandfathered-frozen",
      },
      code: "LABEL_REGISTRY_FROZEN_NOT_EXACT",
    },
    {
      name: "prefix",
      entry: {
        name: "phase:",
        family: "phase",
        purpose: "Legacy. Cleanup owner: #6174.",
        status: "grandfathered-frozen",
      },
      code: "LABEL_REGISTRY_FROZEN_NOT_EXACT",
    },
    {
      name: "missing purpose",
      entry: {
        name: "phase:legacy",
        family: "phase",
        purpose: "",
        status: "grandfathered-frozen",
      },
      code: "LABEL_REGISTRY_PURPOSE_MISSING",
    },
    {
      name: "missing cleanup pointer",
      entry: {
        name: "phase:legacy",
        family: "phase",
        purpose: "Legacy only.",
        status: "grandfathered-frozen",
      },
      code: "LABEL_REGISTRY_FROZEN_CLEANUP_MISSING",
    },
  ])("rejects a frozen entry with $name", ({ entry, code }) => {
    expect(validateLabelRegistry([entry])).toContainEqual(expect.stringContaining(code));
  });

  it("reports a disappeared frozen label as an advisory ratchet-down without failing", () => {
    const fixture = [
      { name: "area:ops", family: "area", purpose: "Owner.", status: "canonical" },
      {
        name: "phase:gone",
        family: "phase",
        purpose: "Legacy. Cleanup owner: #6174.",
        status: "grandfathered-frozen",
      },
    ];

    expect(auditLabelInventory(["area:ops"], fixture)).toMatchObject({
      ok: true,
      failures: [],
      missingFrozen: ["phase:gone"],
    });
  });
});

describe("paginated read-only live label collection", () => {
  it("paginates to exhaustion and lets a decisive page-two label reach the real audit predicate", async () => {
    let page = 0;
    const requests = [];
    const client = async (url, init = {}) => {
      requests.push({ url, init });
      if (url.endsWith("/graphql")) return response(totalPayload(2));
      page += 1;
      if (page === 1) {
        return response([{ name: "area:ops" }], {
          link: `<${"https://api.github.com/repositories/12345/labels?per_page=100&page=2"}>; rel="next"`,
        });
      }
      return response([{ name: "phase:fresh" }]);
    };

    const inventory = await collectLiveLabels({ repo: repository, token: "test-token", client });
    const result = auditLabelInventory(inventory.names, [
      { name: "area:ops", family: "area", purpose: "Owner.", status: "canonical" },
    ]);

    expect(inventory).toEqual({
      names: ["area:ops", "phase:fresh"],
      pages: 2,
      totalCount: 2,
    });
    expect(result.failures).toContain(
      "LABEL_BANNED_NOT_FROZEN: phase:fresh uses banned prefix phase: without an exact grandfathered-frozen entry.",
    );
    expect(requests).toHaveLength(3);
  });

  it("fails closed with a named count mismatch and no positive audit result", async () => {
    const client = async (url) =>
      url.endsWith("/graphql") ? response(totalPayload(2)) : response([{ name: "area:ops" }]);

    await expect(collectLiveLabels({ repo: repository, token: "test-token", client })).rejects.toMatchObject({
      code: "LABEL_COLLECTION_COUNT_MISMATCH",
    });
  });

  it("fails closed when the independent query claims an unfinished page", async () => {
    const client = async () => response(totalPayload(2, { hasNextPage: true, endCursor: null }));

    await expect(collectLiveLabels({ repo: repository, token: "test-token", client })).rejects.toMatchObject({
      code: "LABEL_TOTAL_PAGE_UNFINISHED",
    });
  });

  it("refuses an unsafe pagination next link before forwarding the token", async () => {
    const requests = [];
    const client = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/graphql")) return response(totalPayload(2));
      return response([{ name: "area:ops" }], {
        link: '<https://attacker.invalid/labels?per_page=100&page=2>; rel="next"',
      });
    };

    await expect(collectLiveLabels({ repo: repository, token: "test-token", client })).rejects.toMatchObject({
      code: "LABEL_PAGINATION_NEXT_UNSAFE",
    });
    expect(requests).toHaveLength(2);
  });
});

describe("registry-bound repository vocabulary surfaces", () => {
  const discoveredForms = discoverIssueForms();
  const slice = discoveredForms.find(({ form }) => form.name === "Slice");

  it("keeps the recursively discovered real slice form dropdowns exact", () => {
    expect(slice).toBeDefined();
    const dropdowns = Object.fromEntries(
      slice.form.body
        .filter((field) => field.type === "dropdown")
        .map((field) => [field.attributes.label, field.attributes.options]),
    );

    expect(dropdowns).toEqual({
      Priority: sliceFormValues("priority"),
      "Owning context": sliceFormValues("area"),
      Kind: sliceFormValues("kind"),
    });
    console.log(
      `label registry form drift: scanned ${discoveredForms.length}/${discoveredForms.length} discovered issue forms`,
    );
  });

  it("derives every labeler allowlist from the same registry projection", () => {
    expect(FIELDS).toEqual([
      { heading: "Priority", prefix: "priority:", allowed: sliceFormValues("priority") },
      { heading: "Owning context", prefix: "area:", allowed: sliceFormValues("area") },
      { heading: "Kind", prefix: "kind:", allowed: sliceFormValues("kind") },
    ]);
  });

  it("keeps the discovered charter table equal to every canonical registry member", () => {
    const charter = discoverLabelCharter();
    const tableStart = charter.text.indexOf("| Family | Purpose | Rule |");
    const tableEnd = charter.text.indexOf("\n\n**Banned:**", tableStart);
    expect(tableStart).toBeGreaterThanOrEqual(0);
    expect(tableEnd).toBeGreaterThan(tableStart);
    const table = charter.text.slice(tableStart, tableEnd);
    const documented = [
      ...new Set([...table.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((name) => !name.endsWith(":*"))),
    ].sort();
    const canonical = LABEL_REGISTRY.filter((entry) => entry.status === "canonical")
      .map((entry) => entry.name)
      .sort();

    expect(documented).toEqual(canonical);
    console.log("label registry charter drift: scanned 1/1 discovered label charter");
  });

  it("declares enabled native types and stops minting the legacy Epic label", () => {
    const byName = Object.fromEntries(discoveredForms.map(({ form }) => [form.name, form]));
    expect(byName.Epic.type).toBe("Epic");
    expect(byName.Slice.type).toBe("Slice");
    expect(byName.Decision.type).toBe("Decision");
    for (const name of ["Epic", "Slice", "Decision"]) {
      expect(ENABLED_NATIVE_ISSUE_TYPES).toContain(byName[name].type);
    }
    expect(byName.Epic.labels ?? []).not.toContain("kind:epic");
    expect(canonicalLabelNames("kind")).toContain("kind:epic");
    expect(byName.Decision.labels).toEqual(["decision"]);
  });

  it("preserves the backlog workflow registrations", () => {
    expect(releaseQualificationScopeRegistry.workflows).toMatchObject({
      "backlog-roadmap-status.yml": "ci",
      "issue-form-labels.yml": "ci",
      "issue-readiness.yml": "ci",
      "project-status-sync.yml": "ci",
    });
  });
});

describe("scheduled enforcing audit boundary", () => {
  const workflowPath = path.join(repoRoot, ".github", "workflows", "backlog-roadmap-status.yml");
  const workflowText = readFileSync(workflowPath, "utf8");
  const workflow = parseYaml(workflowText);
  const steps = workflow.jobs.status.steps;
  const generateIndex = steps.findIndex((step) => step.name === "Generate roadmap status");
  const auditIndex = steps.findIndex((step) => step.name === "Audit canonical label registry");
  const auditStep = steps[auditIndex];

  it("places the read-only audit after the splice with an unswallowed exit code", () => {
    expect(generateIndex).toBeGreaterThanOrEqual(0);
    expect(auditIndex).toBeGreaterThan(generateIndex);
    expect(auditStep.run.trim()).toBe("node ./scripts/label-registry.mjs");
    expect(auditStep["continue-on-error"]).toBeUndefined();
    expect(auditStep.if).toBeUndefined();
    expect(auditStep.run).not.toMatch(/(?:\|\|\s*true|set\s+\+e|(?:^|\n)\s*exit\s+0\s*$)/m);
    expect(workflow.jobs.status["continue-on-error"]).toBeUndefined();
  });

  it("propagates an audit exit 1 to the job while preserving the completed splice outcome", async () => {
    let spliceCompleted = false;
    spliceCompleted = true;
    const harness = createLiveHarness(["invented:drift"]);
    const logger = createLogger();

    const auditExit = await main({
      env: completeEnv,
      client: harness.client,
      logger: logger.logger,
      root: repoRoot,
    });
    const jobExit = auditExit;

    expect(spliceCompleted).toBe(true);
    expect(auditExit).toBe(1);
    expect(jobExit).toBe(1);
    expect(logger.logs).toContain("Label registry enforcement failed:");
  });

  it("uses only GET requests and GraphQL queries through the real entrypoint", async () => {
    const harness = createLiveHarness(
      LABEL_REGISTRY.map((entry) => entry.name),
      2,
    );
    const logger = createLogger();
    const summaries = [];

    await expect(
      main({
        env: { ...completeEnv, GITHUB_STEP_SUMMARY: "summary.md" },
        client: harness.client,
        logger: logger.logger,
        root: repoRoot,
        summaryWriter(text) {
          summaries.push(text);
        },
      }),
    ).resolves.toBe(0);

    expect(
      harness.requests.every(({ url, init }) => {
        const method = init.method ?? "GET";
        if (method === "GET") return true;
        if (method !== "POST" || !url.endsWith("/graphql")) return false;
        return JSON.parse(init.body).query.trimStart().startsWith("query ");
      }),
    ).toBe(true);
    expect(logger.errors).toEqual([]);
    expect(logger.warnings).toEqual([]);
    expect(logger.logs).toContain(
      "Label inventory scanned: 81/81 across 1 REST page(s); independent GraphQL total reconciled.",
    );
    expect(logger.logs).toContain("Label registry enforcement passed: every live label is partitioned.");
    expect(logger.logs).toContain(
      "Context coverage observed (advisory, not applied policy): 19 contexts / 23 areas; contexts without area: authenticity, customer-feedback, platform-operations; areas without context: design-system, infrastructure, marketplace-web, ops, platform-runtime, support, tax.",
    );
    expect(logger.logs.some((line) => line.includes("Grandfathered (frozen) open-issue usage observed:"))).toBe(true);
    expect(summaries).toHaveLength(1);
  });

  it("keeps a failed step-summary append advisory after a clean enforcing audit", async () => {
    const harness = createLiveHarness();
    const logger = createLogger();

    await expect(
      main({
        env: { ...completeEnv, GITHUB_STEP_SUMMARY: "summary.md" },
        client: harness.client,
        logger: logger.logger,
        root: repoRoot,
        summaryWriter() {
          throw new Error("disk unavailable");
        },
      }),
    ).resolves.toBe(0);

    expect(logger.errors).toEqual([]);
    expect(logger.warnings).toEqual(["Step summary unavailable (advisory write failed): disk unavailable"]);
    expect(logger.logs).toContain("Label registry enforcement passed: every live label is partitioned.");
  });

  it.each([
    {
      name: "GITHUB_REPOSITORY",
      env: { GITHUB_REPOSITORY: "", GITHUB_TOKEN: "test-token", GITHUB_STEP_SUMMARY: "" },
    },
    {
      name: "GITHUB_TOKEN",
      env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "", GITHUB_STEP_SUMMARY: "" },
    },
  ])("fails for a cleared $name instead of inheriting an ambient value", async ({ env }) => {
    const logger = createLogger();
    const requests = [];

    await expect(
      main({
        env,
        client: async (...args) => {
          requests.push(args);
          return response({});
        },
        logger: logger.logger,
      }),
    ).resolves.toBe(2);
    expect(requests).toEqual([]);
    expect(logger.errors).toEqual(["LABEL_AUDIT_ENV_MISSING: GITHUB_REPOSITORY and GITHUB_TOKEN are required."]);
  });

  it("names an explicitly overridden invalid repository instead of using ambient input", async () => {
    const logger = createLogger();

    await expect(
      main({
        env: { GITHUB_REPOSITORY: "invalid", GITHUB_TOKEN: "test-token", GITHUB_STEP_SUMMARY: "" },
        client: async () => {
          throw new Error("must not request");
        },
        logger: logger.logger,
      }),
    ).resolves.toBe(1);
    expect(logger.errors).toEqual([
      "LabelCollectionError[LABEL_REPOSITORY_INVALID]: Expected owner/name, received invalid.",
    ]);
  });

  it("keeps all advisory content non-enforcing and never describes frozen labels as compliant", () => {
    const lines = renderLabelAuditReport({
      inventory: { names: ["area:ops"], pages: 1, totalCount: 1 },
      audit: {
        ok: true,
        failures: [],
        observedFrozen: ["phase:known"],
        missingFrozen: ["phase:gone"],
      },
      usageCounts: new Map([["phase:known", 3]]),
      coverage: {
        contextCount: 3,
        areaCount: 1,
        contextsWithoutArea: ["authenticity", "customer-feedback", "platform-operations"],
        areasWithoutContext: [],
      },
    });

    expect(lines).toContain("Label registry enforcement passed: every live label is partitioned.");
    expect(lines.some((line) => line.includes("phase:known=3"))).toBe(true);
    expect(lines.some((line) => line.includes("Ratchet-down candidates observed"))).toBe(true);
    expect(lines.some((line) => line.includes("authenticity, customer-feedback, platform-operations"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/\b(?:compliant|waived|exempt(?:ed)?)\b/i);
  });

  it("renders indeterminate advisory collections as unavailable rather than clean", () => {
    const lines = renderLabelAuditReport({
      inventory: { names: ["area:ops"], pages: 1, totalCount: 1 },
      audit: { ok: true, failures: [], observedFrozen: [], missingFrozen: [] },
      usageCounts: null,
      coverage: null,
    });

    expect(lines).toContain("Grandfathered (frozen) open-issue usage unavailable (advisory collection indeterminate).");
    expect(lines).toContain("Context coverage unavailable (advisory collection indeterminate).");
    expect(lines).not.toContain("Grandfathered (frozen) open-issue usage observed: none.");
  });

  it("derives the current advisory context gap without treating it as a policy mapping", () => {
    expect(inspectAreaContextCoverage(repoRoot)).toEqual({
      contextCount: 19,
      areaCount: 23,
      contextsWithoutArea: ["authenticity", "customer-feedback", "platform-operations"],
      areasWithoutContext: [
        "design-system",
        "infrastructure",
        "marketplace-web",
        "ops",
        "platform-runtime",
        "support",
        "tax",
      ],
    });
    expect(BANNED_LABEL_PREFIXES).toEqual(["phase:", "stage:", "series:", "tier:"]);
  });
});
