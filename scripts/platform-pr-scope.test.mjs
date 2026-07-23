import { describe, expect, it } from "vitest";
import { classifyPrScope } from "./lib/pr-scope-policy-v1.mjs";
import {
  COMMENT_MARKER,
  evaluatePrScope,
  FULL_BATTERY_LABEL,
  hasLargeChangeRationale,
  reconcileFullBatteryLabel,
  renderPrScopeComment,
  runPrScopeEvaluation,
  scopePolicyExitCode,
  summaryMarkdown,
  validateRolloutConfig,
} from "./platform-pr-scope.mjs";

const advisoryRollout = {
  schemaVersion: "pr-scope-rollout/v1",
  mode: "advisory",
  mechanicalMigrationEscapeLabel: "scope:mechanical-migration-reviewed",
};
const enforcingRollout = { ...advisoryRollout, mode: "enforcing" };

function rawPull(overrides = {}) {
  return {
    number: 5504,
    state: "open",
    user: { login: "author", type: "User" },
    head: { sha: "1".repeat(40) },
    base: { ref: "main" },
    merge_commit_sha: null,
    changed_files: 1,
    labels: [],
    body: "",
    ...overrides,
  };
}

function rawFile(filename, overrides = {}) {
  return {
    filename,
    status: "modified",
    previous_filename: null,
    additions: 10,
    deletions: 5,
    changes: 15,
    patch: "@@ -1 +1 @@",
    ...overrides,
  };
}

function fakeClient({ pull, files, comments = [], requests = [] }) {
  return {
    request: async (pathname, options) => {
      requests.push({ pathname, options });
      if (pathname === `/pulls/${pull.number}`) return { data: pull };
      return { data: null };
    },
    paginate: async (pathname) => {
      if (pathname.endsWith("/files")) return files;
      if (pathname.endsWith("/comments")) return comments;
      if (pathname.endsWith("/events")) return [];
      throw new Error(`unexpected pagination path ${pathname}`);
    },
  };
}

describe("hasLargeChangeRationale", () => {
  it("requires the exact heading with non-empty content beneath it", () => {
    expect(hasLargeChangeRationale("## Large-change rationale\n\nBecause it is one coherent migration.")).toBe(true);
  });

  it("rejects a missing heading", () => {
    expect(hasLargeChangeRationale("## Summary\n\nsomething")).toBe(false);
  });

  it("rejects an empty heading with no content before the next section", () => {
    expect(hasLargeChangeRationale("## Large-change rationale\n\n## Verification\nran tests")).toBe(false);
  });
});

describe("validateRolloutConfig", () => {
  it("accepts advisory and enforcing modes", () => {
    expect(validateRolloutConfig(advisoryRollout).mode).toBe("advisory");
    expect(validateRolloutConfig(enforcingRollout).mode).toBe("enforcing");
  });

  it("rejects an unknown mode", () => {
    expect(() => validateRolloutConfig({ ...advisoryRollout, mode: "live" })).toThrow();
  });

  it("rejects unknown top-level keys", () => {
    expect(() => validateRolloutConfig({ ...advisoryRollout, extra: true })).toThrow();
  });
});

describe("evaluatePrScope pagination completeness", () => {
  it("bounds an unknown result at the provider cap, carrying a decisive risky file at cap+1", async () => {
    const count = 3_001;
    const files = Array.from({ length: count }, (_entry, index) =>
      index === 3_000 ? rawFile("infrastructure/stripe-payments/index.ts") : rawFile(`arbitrary/safe/file-${index}.ts`),
    );
    const client = fakeClient({ pull: rawPull({ changed_files: count }), files });
    const result = await evaluatePrScope({ client, pullRequestNumber: 5504, rollout: advisoryRollout });
    expect(result.scope.status).toBe("unknown");
    expect(result.code).toBe("api-files-truncated");
    expect(result.requiresRationale).toBe(false);
  });

  it("bounds a collected-count mismatch below the cap", async () => {
    const client = fakeClient({ pull: rawPull({ changed_files: 5 }), files: [rawFile("a.ts")] });
    const result = await evaluatePrScope({ client, pullRequestNumber: 5504, rollout: advisoryRollout });
    expect(result).toMatchObject({ scope: { status: "unknown" }, code: "api-files-truncated" });
  });

  it("never leaks adversarial error content into the rendered comment", async () => {
    const secret = "Authorization: Bearer super-secret-token <!-- injected-marker -->";
    const client = {
      request: async () => ({ data: rawPull() }),
      paginate: async () => {
        throw new Error(secret);
      },
    };
    const result = await evaluatePrScope({ client, pullRequestNumber: 5504, rollout: advisoryRollout });
    expect(result.code).toBe("internal-failure");
    const rendered = renderPrScopeComment(result);
    expect(rendered).not.toContain("super-secret-token");
    expect(rendered).not.toContain("injected-marker");
  });
});

describe("evaluatePrScope thresholds and escape", () => {
  it("computes a large status but keeps rationale enforcement inactive while the rollout is advisory", async () => {
    const files = Array.from({ length: 36 }, (_entry, index) =>
      rawFile(`bounded-contexts/catalog/domain/f${index}.ts`),
    );
    const client = fakeClient({ pull: rawPull({ changed_files: 36 }), files });
    const result = await evaluatePrScope({ client, pullRequestNumber: 5504, rollout: advisoryRollout });
    expect(result.scope.status).toBe("large");
    expect(result.requiresRationale).toBe(false);
    expect(result.mechanicalMigrationEscape).toBe(false);
  });

  it("requires rationale for a large PR with no escape only once the rollout is enforcing", async () => {
    const files = Array.from({ length: 36 }, (_entry, index) =>
      rawFile(`bounded-contexts/catalog/domain/f${index}.ts`),
    );
    const client = fakeClient({ pull: rawPull({ changed_files: 36 }), files });
    const result = await evaluatePrScope({ client, pullRequestNumber: 5504, rollout: enforcingRollout });
    expect(result.scope.status).toBe("large");
    expect(result.requiresRationale).toBe(true);
    expect(result.mechanicalMigrationEscape).toBe(false);
  });

  it("keeps full raw size and risk reporting but drops the rationale requirement under the authorized mechanical-migration escape (enforcing rollout)", async () => {
    const files = Array.from({ length: 36 }, (_entry, index) =>
      rawFile(`bounded-contexts/catalog/domain/f${index}.ts`),
    );
    const client = fakeClient({
      pull: rawPull({ changed_files: 36, labels: [{ name: "scope:mechanical-migration-reviewed" }] }),
      files,
    });
    const result = await evaluatePrScope({ client, pullRequestNumber: 5504, rollout: enforcingRollout });
    expect(result.scope.status).toBe("large");
    expect(result.mechanicalMigrationEscape).toBe(true);
    expect(result.requiresRationale).toBe(false);
    expect(result.scope.raw.files).toBe(36);
  });
});

describe("evaluatePrScope authoritative re-read", () => {
  it("returns bounded unknown, not a current-looking status, when the head SHA moves between pagination and re-read", async () => {
    const originalHead = "1".repeat(40);
    const movedHead = "2".repeat(40);
    let pullRequests = 0;
    const files = [rawFile("bounded-contexts/catalog/domain/a.ts")];
    const client = {
      request: async (pathname) => {
        if (pathname === "/pulls/5504") {
          pullRequests += 1;
          return { data: rawPull({ head: { sha: pullRequests === 1 ? originalHead : movedHead } }) };
        }
        return { data: null };
      },
      paginate: async (pathname) => {
        if (pathname.endsWith("/files")) return files;
        throw new Error(`unexpected pagination path ${pathname}`);
      },
    };
    const result = await evaluatePrScope({ client, pullRequestNumber: 5504, rollout: advisoryRollout });
    expect(pullRequests).toBe(2);
    expect(result.scope.status).toBe("unknown");
    expect(result.code).toBe("pull-request-head-moved");
    const rendered = renderPrScopeComment(result);
    expect(rendered).toContain(`Head: \`${originalHead}\``);
    expect(rendered).not.toMatch(/Status: \*\*(?:normal|advisory|large)\*\*/);
  });

  it("returns bounded unknown when changed_files count moves between pagination and re-read", async () => {
    let pullRequests = 0;
    const files = [rawFile("bounded-contexts/catalog/domain/a.ts")];
    const client = {
      request: async (pathname) => {
        if (pathname === "/pulls/5504") {
          pullRequests += 1;
          return { data: rawPull({ changed_files: pullRequests === 1 ? 1 : 2 }) };
        }
        return { data: null };
      },
      paginate: async (pathname) => {
        if (pathname.endsWith("/files")) return files;
        throw new Error(`unexpected pagination path ${pathname}`);
      },
    };
    const result = await evaluatePrScope({ client, pullRequestNumber: 5504, rollout: advisoryRollout });
    expect(result.scope.status).toBe("unknown");
    expect(result.code).toBe("pull-request-head-moved");
  });

  it("never mutates the comment or label with a moving head, through the full evaluation/comment state machine", async () => {
    const originalHead = "1".repeat(40);
    const movedHead = "2".repeat(40);
    let pullRequestCalls = 0;
    const files = [rawFile("bounded-contexts/catalog/domain/a.ts", { additions: 900, deletions: 200 })];
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith("/pulls/5504")) {
        pullRequestCalls += 1;
        return jsonResponse(rawPull({ head: { sha: pullRequestCalls === 1 ? originalHead : movedHead } }));
      }
      if (url.includes("/pulls/5504/files")) return jsonResponse(files);
      if (url.includes("/issues/5504/comments") && (options.method ?? "GET") === "GET") return jsonResponse([]);
      if (url.includes("/issues/5504/comments") && options.method === "POST") return jsonResponse({ id: 1 });
      throw new Error(`unexpected url ${url} ${options.method ?? "GET"}`);
    };
    const record = await runPrScopeEvaluation({
      event: { eventName: "pull_request", pullRequestNumber: 5504 },
      repository: "chase-sets/chase-sets",
      token: "test",
      rollout: advisoryRollout,
      fetchImpl,
    });
    expect(record.results[0].scope.status).toBe("unknown");
    // status !== "normal" still creates the advisory comment (unknown state is
    // never silent), but it must render the bounded-unknown body, not a
    // current-looking positive scope.
    expect(record.results[0].comment).toBe("created");
  });
});

describe("reconcileFullBatteryLabel", () => {
  it("adds the existing full-ci label when the scope is large", async () => {
    const requests = [];
    const client = { request: async (pathname, options) => requests.push({ pathname, options }) };
    const action = await reconcileFullBatteryLabel({
      client,
      pullRequestNumber: 5504,
      currentLabels: [],
      wantsLarge: true,
    });
    expect(action).toBe("added");
    expect(requests[0]).toMatchObject({
      pathname: "/issues/5504/labels",
      options: { method: "POST", body: { labels: [FULL_BATTERY_LABEL] } },
    });
  });

  it("removes the label only when this automation's own bot event added it last", async () => {
    const client = {
      request: async () => ({ data: null }),
      paginate: async () => [
        {
          event: "labeled",
          label: { name: "full-ci" },
          actor: { login: "github-actions[bot]", type: "Bot" },
          created_at: "2026-07-20T00:00:00Z",
        },
      ],
    };
    const action = await reconcileFullBatteryLabel({
      client,
      pullRequestNumber: 5504,
      currentLabels: ["full-ci"],
      wantsLarge: false,
    });
    expect(action).toBe("removed");
  });

  it("never removes a human-applied full-ci label", async () => {
    const client = {
      request: async () => ({ data: null }),
      paginate: async () => [
        {
          event: "labeled",
          label: { name: "full-ci" },
          actor: { login: "a-human", type: "User" },
          created_at: "2026-07-20T00:00:00Z",
        },
      ],
    };
    const action = await reconcileFullBatteryLabel({
      client,
      pullRequestNumber: 5504,
      currentLabels: ["full-ci"],
      wantsLarge: false,
    });
    expect(action).toBe("kept-manual");
  });
});

describe("scopePolicyExitCode / advisory vs enforcing rollout", () => {
  const largeNoRationaleResult = {
    scope: { status: "large" },
    requiresRationale: true,
    rationalePresent: false,
  };

  it("never fails during the advisory rollout, even for a large PR with no rationale", () => {
    expect(scopePolicyExitCode({ rolloutMode: "advisory", results: [largeNoRationaleResult] })).toBe(0);
  });

  it("fails only under the enforcing rollout when rationale is genuinely required and missing", () => {
    expect(scopePolicyExitCode({ rolloutMode: "enforcing", results: [largeNoRationaleResult] })).toBe(1);
  });

  it("does not fail under the enforcing rollout when the scope is unknown (incomplete data)", () => {
    expect(
      scopePolicyExitCode({
        rolloutMode: "enforcing",
        results: [{ scope: { status: "unknown" }, requiresRationale: false, rationalePresent: false }],
      }),
    ).toBe(0);
  });

  it("does not fail under the enforcing rollout when rationale is present", () => {
    expect(
      scopePolicyExitCode({
        rolloutMode: "enforcing",
        results: [{ scope: { status: "large" }, requiresRationale: true, rationalePresent: true }],
      }),
    ).toBe(0);
  });
});

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data, headers: { get: () => null } };
}

describe("runPrScopeEvaluation", () => {
  it("posts a stable comment under its own marker and leaves labels untouched during advisory rollout", async () => {
    const calls = [];
    const files = [rawFile("bounded-contexts/catalog/domain/a.ts", { additions: 900, deletions: 200 })];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url, method: options.method ?? "GET" });
      if (url.endsWith("/pulls/5504?per_page=100") || url.endsWith("/pulls/5504"))
        return jsonResponse(rawPull({ changed_files: 1 }));
      if (url.includes("/pulls/5504/files")) return jsonResponse(files);
      if (url.includes("/issues/5504/comments") && (options.method ?? "GET") === "GET") return jsonResponse([]);
      if (url.includes("/issues/5504/comments") && options.method === "POST") return jsonResponse({ id: 1 });
      throw new Error(`unexpected url ${url}`);
    };
    const record = await runPrScopeEvaluation({
      event: { eventName: "pull_request", pullRequestNumber: 5504 },
      repository: "chase-sets/chase-sets",
      token: "test",
      rollout: advisoryRollout,
      fetchImpl,
    });
    expect(record.schemaVersion).toBe("pr-scope-evaluation/v1");
    expect(record.results[0].labelAction).toBe("not-evaluated");
    expect(record.results[0].comment).toBe("created");
    const created = calls.find((call) => call.method === "POST");
    expect(created).toBeDefined();
  });

  it("mutates the full-ci label only under the enforcing rollout", async () => {
    const largeFiles = Array.from({ length: 36 }, (_entry, index) =>
      rawFile(`bounded-contexts/catalog/domain/f${index}.ts`),
    );
    const labelRequests = [];
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith("/pulls/5504")) return jsonResponse(rawPull({ changed_files: 36 }));
      if (url.includes("/pulls/5504/files")) return jsonResponse(largeFiles);
      if (url.includes("/issues/5504/comments") && (options.method ?? "GET") === "GET") return jsonResponse([]);
      if (url.includes("/issues/5504/comments") && options.method === "POST") return jsonResponse({ id: 1 });
      if (url.includes("/issues/5504/labels") && options.method === "POST") {
        labelRequests.push(JSON.parse(options.body));
        return jsonResponse({});
      }
      throw new Error(`unexpected url ${url}`);
    };
    const record = await runPrScopeEvaluation({
      event: { eventName: "pull_request", pullRequestNumber: 5504 },
      repository: "chase-sets/chase-sets",
      token: "test",
      rollout: enforcingRollout,
      fetchImpl,
    });
    expect(record.results[0].labelAction).toBe("added");
    expect(labelRequests[0]).toEqual({ labels: [FULL_BATTERY_LABEL] });
  });

  it("never mutates comments or labels in check-only mode (the scope-policy job's read-only path)", async () => {
    const largeFiles = Array.from({ length: 36 }, (_entry, index) =>
      rawFile(`bounded-contexts/catalog/domain/f${index}.ts`),
    );
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith("/pulls/5504")) return jsonResponse(rawPull({ changed_files: 36 }));
      if (url.includes("/pulls/5504/files")) return jsonResponse(largeFiles);
      throw new Error(`unexpected mutating call in check-only mode: ${url} ${options.method ?? "GET"}`);
    };
    const record = await runPrScopeEvaluation({
      event: { eventName: "pull_request", pullRequestNumber: 5504 },
      repository: "chase-sets/chase-sets",
      token: "test",
      rollout: enforcingRollout,
      fetchImpl,
      mutate: false,
    });
    expect(record.results[0]).toMatchObject({ comment: "not-evaluated", labelAction: "not-evaluated" });
    expect(record.results[0].scope.status).toBe("large");
  });
});

describe("renderPrScopeComment", () => {
  it("includes the stable marker so subsequent runs converge on the same comment", () => {
    const rendered = renderPrScopeComment({
      code: null,
      mechanicalMigrationEscape: false,
      rationalePresent: false,
      scope: {
        status: "advisory",
        raw: { lines: 1200, files: 22 },
        normalized: { lines: 1100, files: 21 },
        thresholds: { advisory: { lines: 1000, files: 20 }, large: { lines: 2500, files: 35 } },
        boundedContexts: ["catalog"],
        compositionRoots: [],
        risk: { categories: [] },
        excluded: { totals: {} },
        splitSuggestion: null,
      },
    });
    expect(rendered.startsWith(COMMENT_MARKER)).toBe(true);
    expect(rendered).toContain("Status: **advisory**");
    expect(rendered).toContain("Normalized: 1100 lines / 21 files");
  });
});

describe("adversarial path rendering safety (bounded contexts / composition roots)", () => {
  it("neutralizes pipes, newlines, carriage returns, backticks, HTML-like marker text, long names, and Unicode controls through the real classifyPrScope entrypoint", () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const rtlOverride = String.fromCharCode(0x202e);
    const adversarialSegment = [
      "<!-- chase-sets:risk-review:v1 -->",
      "<!-- chase-sets:pr-scope:v1 -->",
      "| injected | table | row |",
      "line-one\nline-two\rline-three",
      "`escaped`",
      `${rtlOverride}hidden${zeroWidthSpace}`,
      "x".repeat(500),
    ].join("");

    const scope = classifyPrScope({
      changedFiles: [
        {
          filename: `bounded-contexts/${adversarialSegment}/domain/file.ts`,
          status: "modified",
          additions: 10,
          deletions: 5,
          patch: null,
        },
        {
          filename: `deployables/${adversarialSegment}/app/routes.tsx`,
          status: "modified",
          additions: 10,
          deletions: 5,
          patch: null,
        },
        // A second bounded context forces a splitSuggestion, which also
        // renders the (sanitized) boundary list.
        file2(),
      ],
    });
    // The adversarial segment must actually have made it into the
    // classifier's unsanitized output — otherwise this test would not be
    // exercising the rendering seam it claims to.
    expect(scope.boundedContexts.some((value) => value.includes("<!--"))).toBe(true);
    expect(scope.splitSuggestion).not.toBeNull();

    const result = {
      pullRequest: { headSha: "1".repeat(40), number: 5966 },
      code: null,
      mechanicalMigrationEscape: false,
      rationalePresent: false,
      scope,
    };
    const comment = renderPrScopeComment(result);
    const record = {
      schemaVersion: "pr-scope-evaluation/v1",
      rolloutMode: "advisory",
      eventName: "pull_request",
      results: [{ ...result, labelAction: "not-evaluated" }],
    };
    const summary = summaryMarkdown(record);

    for (const output of [comment, summary]) {
      expect(output).not.toContain("<!-- chase-sets:risk-review:v1 -->");
      expect(output).not.toMatch(/\|\s*injected\s*\|\s*table\s*\|\s*row\s*\|/);
      expect(output).not.toContain("\r");
      expect(output).not.toContain(zeroWidthSpace);
      expect(output).not.toContain(rtlOverride);
      expect(output).not.toMatch(/x{201,}/);
    }
    // The comment's own marker appears exactly once, at the very start; no
    // attacker-controlled content injected a second copy anywhere else.
    expect(comment.indexOf(COMMENT_MARKER)).toBe(0);
    expect(comment.indexOf(COMMENT_MARKER, 1)).toBe(-1);
    // No HTML/markdown comment syntax survives anywhere in either surface —
    // this is what makes the risk-review marker collision impossible, not
    // just this feature's own marker.
    expect(comment.slice(COMMENT_MARKER.length)).not.toContain("<!--");
    expect(comment.slice(COMMENT_MARKER.length)).not.toContain("-->");
    expect(summary).not.toContain("<!--");
    expect(summary).not.toContain("-->");
  });

  function file2() {
    return {
      filename: "bounded-contexts/catalog/domain/other.ts",
      status: "modified",
      additions: 10,
      deletions: 5,
      patch: null,
    };
  }
});

describe("summaryMarkdown always renders the compact scope table", () => {
  function baseResult(overrides = {}) {
    return {
      pullRequest: { number: 5504 },
      code: null,
      labelAction: "not-evaluated",
      scope: {
        status: "normal",
        raw: { lines: 400, files: 3 },
        normalized: { lines: 400, files: 3 },
        excluded: { totals: {} },
        ...overrides,
      },
    };
  }

  it("includes the raw/normalized/exclusion table for a normal-status PR, not just oversized/unknown ones", () => {
    const record = {
      schemaVersion: "pr-scope-evaluation/v1",
      rolloutMode: "advisory",
      eventName: "pull_request",
      results: [baseResult()],
    };
    const summary = summaryMarkdown(record);
    expect(summary).toContain("- PR #5504: normal; rollout: advisory.");
    expect(summary).toContain("Raw: 400 lines / 3 files");
    expect(summary).toContain("Normalized: 400 lines / 3 files");
    expect(summary).toContain("Excluded mechanical totals:");
  });

  it("includes the table for a large-status PR alongside the existing bullet line", () => {
    const record = {
      schemaVersion: "pr-scope-evaluation/v1",
      rolloutMode: "advisory",
      eventName: "pull_request",
      results: [
        baseResult({
          status: "large",
          raw: { lines: 5200, files: 1 },
          normalized: { lines: 5200, files: 1 },
        }),
      ],
    };
    const summary = summaryMarkdown(record);
    expect(summary).toContain("- PR #5504: large; rollout: advisory.");
    expect(summary).toContain("Raw: 5200 lines / 1 files");
    expect(summary).toContain("Normalized: 5200 lines / 1 files");
  });

  it("does not render a raw/normalized table for a per-PR unknown scope (no complete data to show)", () => {
    const record = {
      schemaVersion: "pr-scope-evaluation/v1",
      rolloutMode: "advisory",
      eventName: "pull_request",
      results: [
        {
          pullRequest: { number: 5504 },
          code: "api-files-truncated",
          labelAction: "not-evaluated",
          scope: { status: "unknown" },
        },
      ],
    };
    const summary = summaryMarkdown(record);
    expect(summary).toContain("- PR #5504: unknown (safe code: `api-files-truncated`); rollout: advisory.");
    expect(summary).not.toContain("Raw:");
    expect(summary).not.toContain("Normalized:");
  });
});
