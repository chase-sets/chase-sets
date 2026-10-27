import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_LOG_BYTES,
  STAGING_CONTEXT,
  assertReadOnlyKubectl,
  buildCurlRequestArgs,
  buildKubectlLogsArgs,
  buildProbeWindow,
  classifyAc5Rows,
  classifyCollectorConfig,
  filterLogWindow,
  isCompleteLogRead,
  main,
  overallVerdict,
  parseArgs,
  selectReadyPods,
  serializeEvidence,
  toRfc3339,
} from "./ac5-logging-probe.mjs";

const userAgent = "ac5-probe/synthetic";
const sentinels = ["ac5-q-synthetic", "ac5-r-synthetic"];
const requests = [
  { name: "R1", status: 200, exit: 0 },
  { name: "R2", status: 200, exit: 0 },
  { name: "R3", status: 413, exit: 0 },
  { name: "R4", status: 404, exit: 0 },
];
const marketplaceLine = "2026-10-26T19:32:00Z GET /sign-in 200 120 - 1 ms";
const controllerLines = [
  `2026-10-26T19:32:00Z 10.0.0.1 - - "GET /sign-in HTTP/2.0" 200 120 "${userAgent}" 10 0.001 [platform] - 10.0.0.2 120 0.001 200 req-1`,
  `2026-10-26T19:32:03Z 10.0.0.1 - - "GET /api/health HTTP/2.0" 200 120 "${userAgent}" 10 0.001 [platform] - 10.0.0.2 120 0.001 200 req-2`,
  `2026-10-26T19:32:06Z 10.0.0.1 - - "POST /sign-in HTTP/2.0" 413 120 "${userAgent}" 10 0.001 [platform] - 10.0.0.2 120 0.001 413 req-3`,
].join("\n");

function complete(lines) {
  return { complete: true, lines: String(lines).split("\n").filter(Boolean) };
}
function collectorConfig() {
  const deletes = ["http.target", "http.url", "url.full", "url.query"]
    .map((key) => `          - delete_key(attributes, "${key}")`)
    .join("\n");
  return {
    data: {
      "agent.yaml": `processors:\n  transform/drop_sensitive:\n    trace_statements:\n      - statements:\n${deletes}\n    log_statements:\n      - statements:\n${deletes}`,
    },
  };
}
function classify(overrides = {}) {
  return classifyAc5Rows({
    marketplaceLogs: complete(marketplaceLine),
    controllerLogs: complete(controllerLines),
    collector: classifyCollectorConfig(collectorConfig()),
    sentinels,
    userAgent,
    requests,
    qualification: { defaultBackendLoggingDisabled: true },
    ...overrides,
  });
}

describe("AC5 logging probe", () => {
  it("parses the documented kebab-case CLI and rejects unknown flags (F3)", () => {
    const options = parseArgs([
      "--deploy-run-id",
      "123",
      "--merge-sha",
      "a".repeat(40),
      "--promoted-digest",
      `sha256:${"b".repeat(64)}`,
      "--staging-host",
      "staging.example.test",
      "--r4-host",
      "unknown.example.test",
      "--context",
      STAGING_CONTEXT,
    ]);
    expect(options.deployRunId).toBe("123");
    expect(() => parseArgs(["--not-a-real-flag", "x"])).toThrow("ac5_unknown_argument");
    expect(() =>
      parseArgs([
        "--deploy-run-id",
        "123",
        "--merge-sha",
        "a".repeat(40),
        "--promoted-digest",
        `sha256:${"b".repeat(64)}`,
        "--staging-host",
        "staging.example.test",
        "--r4-host",
        "unknown.example.test",
      ]),
    ).toThrow("ac5_staging_context_required");
  });

  it("keeps the staging context on every logs argv and refuses non-staging contexts (F12)", () => {
    expect(
      buildKubectlLogsArgs({ namespace: "ingress-nginx", pod: "controller-abc", since: "2026-10-26T19:31:55Z" })[0],
    ).toBe(`--context=${STAGING_CONTEXT}`);
    expect(() =>
      buildKubectlLogsArgs({ namespace: "n", pod: "p", since: "2026-10-26T19:31:55Z", context: "production" }),
    ).toThrow("ac5_invalid_logs_arguments");
    expect(() => assertReadOnlyKubectl(["--context=" + STAGING_CONTEXT, "delete", "pod", "x"])).toThrow(
      "ac5_read_only_command_refused",
    );
    expect(() => assertReadOnlyKubectl(["get", "secrets", "-A", "-o", "json"])).toThrow(
      "ac5_read_only_command_refused",
    );
  });

  it("builds pathname-safe requests, with insecure TLS only for R4 (F4, F8)", () => {
    const base = {
      host: "staging.example.test",
      path: "/sign-in",
      sentinels: { query: "q1", referer: "r1" },
      resolveIP: "192.0.2.10",
      userAgent,
    };
    const r1 = buildCurlRequestArgs(base);
    const r4 = buildCurlRequestArgs({ ...base, path: "/probe", r4: true });
    expect(r1).toContain("--max-redirs");
    expect(r1).not.toContain("--insecure");
    expect(r4).toContain("--insecure");
    expect(r4).toContain("staging.example.test:443:192.0.2.10");
  });

  it("uses the actual deployment labels and selects only ready marketplace pods (F2)", () => {
    const list = {
      items: [
        {
          metadata: {
            name: "marketplace-1",
            namespace: "n",
            labels: { "app.kubernetes.io/name": "chase-sets-platform", "app.kubernetes.io/component": "marketplace" },
          },
          status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
        },
        {
          metadata: { name: "old-rollout", namespace: "n", labels: { "app.kubernetes.io/name": "marketplace" } },
          status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
        },
      ],
    };
    expect(selectReadyPods(list, { namespace: "n", role: "marketplace" })).toEqual(["marketplace-1"]);
  });

  it("passes Route B with no default-backend access line and measured controls", () => {
    const rows = classify();
    expect(rows.web.status).toBe("PASS");
    expect(rows.ingressAccess.status).toBe("PASS");
    expect(rows.ingressError.status).toBe("PASS");
    expect(rows.controllerDefault).toMatchObject({ status: "PASS", controls: { r4: 0 } });
    expect(rows.collector).toMatchObject({ status: "PASS", controls: { traceDeletes: 4, logDeletes: 4 } });
  });

  it("turns a real query-string leak red instead of treating it as a pass (F5, F6, F8)", () => {
    const rows = classify({ marketplaceLogs: complete(`${marketplaceLine}?token=${sentinels[0]}`) });
    expect(rows.web.status).toBe("FAIL");
    const controllerLeak = `${controllerLines}\n2026-10-26T19:32:08Z 10.0.0.1 - - "GET /api/health?${sentinels[0]} HTTP/2.0" 200 1 "${userAgent}" 10 0 [platform] - - - - req-4`;
    expect(classify({ controllerLogs: complete(controllerLeak) }).ingressAccess.status).toBe("FAIL");
  });

  it("does not fail unrelated user agents, but refuses missing attribution (F8)", () => {
    const unrelated = `${controllerLines}\n2026-10-26T19:32:08Z 10.0.0.9 - - "GET /sign-in HTTP/2.0" 200 1 "bot/?about" 10 0 [platform] - - - - other`;
    expect(classify({ controllerLogs: complete(unrelated) }).ingressAccess.status).toBe("PASS");
    expect(
      classify({ controllerLogs: complete(controllerLines.replaceAll(userAgent, "other-agent")) }).ingressAccess.status,
    ).toBe("INCONCLUSIVE");
  });

  it("requires the R3 413 access control and rejects request-scoped error text (F5)", () => {
    expect(
      classify({
        controllerLogs: complete(
          controllerLines.replace(/POST \/sign-in HTTP\/2\.0" 413/, 'POST \/sign-in HTTP\/2.0" 200'),
        ),
      }).ingressError.status,
    ).toBe("INCONCLUSIVE");
    expect(
      classify({
        controllerLogs: complete(
          `${controllerLines}\n2026-10-26T19:32:07Z [error] client intended to send too large body: request: \"POST /sign-in?${sentinels[0]}\"`,
        ),
      }).ingressError.status,
    ).toBe("FAIL");
  });

  it("requires a negative R4 control and does not accept an application 404 (F1, F6)", () => {
    const app404 = `${controllerLines}\n2026-10-26T19:32:07Z 10.0.0.1 - - "GET /probe HTTP/2.0" 404 1 "other-agent" 10 0 [marketplace] - - - - other`;
    expect(classify({ controllerLogs: complete(app404) }).controllerDefault.status).toBe("PASS");
    const defaultLine = `${controllerLines}\n2026-10-26T19:32:07Z 10.0.0.1 - - "GET /probe HTTP/2.0" 404 1 "${userAgent}" 10 0 [upstream-default-backend] - - - - r4`;
    expect(classify({ controllerLogs: complete(defaultLine) }).controllerDefault.status).toBe("FAIL");
    expect(classify({ qualification: { defaultBackendLoggingDisabled: false } }).controllerDefault.status).toBe(
      "INCONCLUSIVE",
    );
  });

  it("treats byte-limit boundaries and timestamp parse failures as incomplete (F7, F9)", () => {
    expect(isCompleteLogRead({ bytes: MAX_LOG_BYTES - 1, exit: 0 })).toBe(true);
    expect(isCompleteLogRead({ bytes: MAX_LOG_BYTES, exit: 0 })).toBe(false);
    expect(isCompleteLogRead({ bytes: 12, exit: 1 })).toBe(false);
    const window = buildProbeWindow({ r1At: "2026-10-26T19:32:00Z", r4At: "2026-10-26T19:32:07Z" });
    expect(filterLogWindow(`${window.t0} GET /inside\n2026-10-26T19:32:30Z GET /late`, window).lines).toHaveLength(1);
    expect(filterLogWindow("not-a-timestamp GET /bad", window).complete).toBe(false);
    expect(() => buildProbeWindow({ r1At: "2026-10-26T19:32:00Z", r4At: "2026-10-26T19:34:00Z" })).toThrow(
      "ac5_probe_window_too_long",
    );
  });

  it("asserts trace and log statement sets independently (F11)", () => {
    const config = collectorConfig();
    expect(classifyCollectorConfig(config)).toMatchObject({
      traceDeletes: true,
      logDeletes: true,
      traceCount: 4,
      logCount: 4,
    });
    config.data["agent.yaml"] = config.data["agent.yaml"].replace(
      'delete_key(attributes, "http.url")',
      'delete_key(attributes, "other")',
    );
    expect(classifyCollectorConfig(config)).toMatchObject({ traceDeletes: false, logDeletes: true });
    config.data["agent.yaml"] = collectorConfig().data["agent.yaml"].replace(
      'delete_key(attributes, "http.url")',
      'delete_key(attributes, "other")',
    );
    const split = config.data["agent.yaml"].split("    log_statements:");
    config.data["agent.yaml"] =
      `${split[0]}    log_statements:${split[1].replace('delete_key(attributes, "http.url")', 'delete_key(attributes, "other")')}`;
    expect(classifyCollectorConfig(config)).toMatchObject({ traceDeletes: false, logDeletes: false });
  });

  it("makes every row inconclusive for incomplete reads and preserves a sentinel-free evidence record (F4, F7, F13)", () => {
    const incomplete = classify({ marketplaceLogs: { complete: false, lines: [] } });
    expect(Object.values(incomplete).every((result) => result.status === "INCONCLUSIVE")).toBe(true);
    const output = serializeEvidence({
      qualification: { context: STAGING_CONTEXT },
      requests: [
        {
          name: "R1",
          method: "GET",
          path: "/sign-in",
          status: 200,
          exit: 0,
          stderrBytes: 1,
          stderrPrefix: `query=${sentinels[0]}`,
        },
      ],
      reads: [{ namespace: "n", pod: "p", bytes: 10, complete: true, exit: 0, timedOut: false }],
      rows: classify(),
      sentinels,
      overall: "PASS",
    });
    expect(output).not.toContain(sentinels[0]);
    expect(output).toContain('"overall": "PASS"');
    expect(() =>
      serializeEvidence({ qualification: {}, requests: [], reads: [], rows: {}, sentinels: ["leak"], overall: "FAIL" }),
    ).not.toThrow();
  });

  it("writes evidence and still reads sinks when R4 fails TLS (F4)", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "ac5-probe-test-"));
    const output = join(outputDir, "evidence.json");
    const sha = "a".repeat(40);
    const digest = `sha256:${"b".repeat(64)}`;
    const chart = readFileSync("infrastructure/helm/doks-ingress/ingress-nginx-values.yaml", "utf8");
    const logFormat = chart.match(/log-format-upstream:\s*'([^']+)'/)?.[1];
    let clock = Date.parse("2026-10-26T19:32:00Z");
    const marketplacePod = {
      metadata: {
        name: "marketplace-1",
        namespace: "chase-sets-platform",
        labels: { "app.kubernetes.io/name": "chase-sets-platform", "app.kubernetes.io/component": "marketplace" },
      },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [{ imageID: `registry.example/app@${digest}` }],
      },
    };
    const controllerPod = {
      metadata: {
        name: "controller-1",
        namespace: "ingress-nginx",
        labels: { "app.kubernetes.io/name": "ingress-nginx" },
      },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
    };
    const deployment = {
      kind: "Deployment",
      metadata: { generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    };
    const daemonSet = {
      metadata: { generation: 1 },
      status: {
        observedGeneration: 1,
        desiredNumberScheduled: 1,
        updatedNumberScheduled: 1,
        numberReady: 1,
        numberAvailable: 1,
      },
    };
    const configMap = { data: { "log-format-upstream": logFormat, "error-log-path": "/dev/null" } };
    const runner = async (command, args) => {
      if (command === "gh" && args[1] === "view")
        return {
          stdout: JSON.stringify({
            headSha: sha,
            status: "completed",
            conclusion: "success",
            workflowName: "Platform Deploy",
            createdAt: "2026-10-26T19:00:00Z",
          }),
          stderr: "",
        };
      if (command === "gh" && args[1] === "list") return { stdout: "[]", stderr: "" };
      if (command === "git") return { stdout: "", stderr: "" };
      if (command === "curl") {
        if (args.some((arg) => String(arg).includes("unknown.example.test")))
          throw Object.assign(new Error("certificate verify failed"), {
            code: 60,
            stderr: Buffer.from("certificate verify failed"),
          });
        const status = args.some((arg) => String(arg).includes("/api/health"))
          ? "200"
          : args.some((arg) => String(arg).includes("--request"))
            ? "413"
            : "200";
        return { stdout: status, stderr: "" };
      }
      const actual = args.slice(1);
      if (actual[0] === "logs")
        return { stdout: actual[1] === "controller-1" ? controllerLines : marketplaceLine, stderr: "" };
      if (actual[0] === "get" && actual[1] === "daemonset") return { stdout: JSON.stringify(daemonSet), stderr: "" };
      if (
        actual[0] === "get" &&
        actual[1] === "configmap" &&
        actual[2] === "chase-sets-platform-chase-sets-platform-observability"
      )
        return { stdout: JSON.stringify({ data: collectorConfig().data }), stderr: "" };
      if (actual[0] === "get" && actual[1] === "deployment") return { stdout: JSON.stringify(deployment), stderr: "" };
      if (actual[0] === "get" && actual[1] === "pods" && actual[3] === "chase-sets-platform")
        return { stdout: JSON.stringify({ items: [marketplacePod] }), stderr: "" };
      if (actual[0] === "get" && actual[1] === "pods")
        return { stdout: JSON.stringify({ items: [controllerPod] }), stderr: "" };
      if (actual[0] === "get" && actual[1] === "configmap") return { stdout: JSON.stringify(configMap), stderr: "" };
      if (actual[0] === "get" && actual[1] === "service")
        return {
          stdout: JSON.stringify({ status: { loadBalancer: { ingress: [{ ip: "192.0.2.10" }] } } }),
          stderr: "",
        };
      if (actual[0] === "get" && actual[1] === "ingress")
        return {
          stdout: JSON.stringify({ items: [{ spec: { rules: [{ host: "staging.example.test" }] } }] }),
          stderr: "",
        };
      if (actual[0] === "get" && actual[1].startsWith("deployments,"))
        return { stdout: JSON.stringify({ items: [] }), stderr: "" };
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    };
    try {
      const result = await main(
        [
          "--deploy-run-id",
          "123",
          "--merge-sha",
          sha,
          "--promoted-digest",
          digest,
          "--staging-host",
          "staging.example.test",
          "--r4-host",
          "unknown.example.test",
          "--context",
          STAGING_CONTEXT,
          "--output",
          output,
        ],
        {
          runner,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      );
      expect(result.rows.controllerDefault.status).toBe("INCONCLUSIVE");
      expect(readFileSync(output, "utf8")).toContain('"overall": "INCONCLUSIVE"');
    } finally {
      process.exitCode = undefined;
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("computes an explicit overall verdict rather than exiting zero for a red row (F13, F14)", () => {
    expect(overallVerdict(classify())).toBe("PASS");
    const rows = classify({ marketplaceLogs: complete(`${marketplaceLine}?${sentinels[0]}`) });
    expect(overallVerdict(rows)).toBe("FAIL");
    expect(overallVerdict(classify({ controllerLogs: { complete: false, lines: [] } }))).toBe("INCONCLUSIVE");
  });

  it("keeps RFC3339 timestamps and request-window anchoring deterministic", () => {
    expect(toRfc3339("2026-10-26T19:32:00.867213Z")).toBe("2026-10-26T19:32:00Z");
    expect(buildProbeWindow({ r1At: "2026-10-26T19:32:00Z", r4At: "2026-10-26T19:32:07Z" })).toMatchObject({
      t0: "2026-10-26T19:31:55Z",
      t1: "2026-10-26T19:32:22Z",
    });
  });
});
