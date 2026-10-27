import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  verdictExitCode,
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

function mainFixture(overrides = {}) {
  const outputDir = mkdtempSync(join(tmpdir(), "ac5-probe-test-"));
  const output = join(outputDir, "evidence.json");
  const sha = "a".repeat(40);
  const digest = `sha256:${"b".repeat(64)}`;
  const chart = readFileSync("infrastructure/helm/doks-ingress/ingress-nginx-values.yaml", "utf8");
  const logFormat = chart.match(/log-format-upstream:\s*'([^']+)'/)?.[1];
  const pod = (name, namespace, labels) => ({
    metadata: { name, namespace, labels },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ imageID: `registry.example/app@${digest}` }],
    },
  });
  const data = {
    deploy: {
      headSha: sha,
      status: "completed",
      conclusion: "success",
      workflowName: "Platform Deploy",
      createdAt: "2026-10-26T19:00:00Z",
    },
    deployRuns: [],
    deployment: {
      kind: "Deployment",
      metadata: { generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    },
    daemonSet: {
      metadata: { generation: 1 },
      status: {
        observedGeneration: 1,
        desiredNumberScheduled: 1,
        updatedNumberScheduled: 1,
        numberReady: 1,
        numberAvailable: 1,
      },
    },
    marketplacePods: {
      items: [
        pod("marketplace-1", "chase-sets-platform", {
          "app.kubernetes.io/name": "chase-sets-platform",
          "app.kubernetes.io/component": "marketplace",
        }),
      ],
    },
    controllerPods: {
      items: [pod("controller-1", "ingress-nginx", { "app.kubernetes.io/name": "ingress-nginx" })],
    },
    configMap: { data: { "log-format-upstream": logFormat, "error-log-path": "/dev/null" } },
    collector: collectorConfig(),
    service: { status: { loadBalancer: { ingress: [{ ip: "192.0.2.10" }] } } },
    ingress: { items: [{ spec: { rules: [{ host: "staging.example.test" }] } }] },
    inventory: { items: [] },
  };
  overrides.change?.(data);
  let clock = Date.parse("2026-10-26T19:32:00Z");
  const calls = [];
  const json = (value) => ({ stdout: JSON.stringify(value), stderr: "" });
  const runner = async (command, args) => {
    calls.push({ command, args });
    const actual = command === "kubectl" ? args.slice(1) : args;
    if (overrides.accessFailure?.(command, actual)) throw Object.assign(new Error("access denied"), { code: 1 });
    if (command === "gh") return json(args[1] === "view" ? data.deploy : data.deployRuns);
    if (command === "git") {
      if (overrides.nonAncestor) throw Object.assign(new Error("not ancestor"), { code: 1 });
      return { stdout: "", stderr: "" };
    }
    if (command === "curl") {
      clock += overrides.requestDurationMs ?? 0;
      const r4 = args.at(-1).includes("unknown.example.test");
      if (r4 && overrides.r4TlsFailure)
        throw Object.assign(new Error("certificate verify failed"), { code: 60, stderr: "certificate verify failed" });
      return { stdout: r4 ? "404" : args.includes("--request") ? "413" : "200", stderr: "" };
    }
    if (actual[0] === "logs") {
      const curl = calls.find((call) => call.command === "curl");
      const ua = curl.args.find((arg) => arg.startsWith("User-Agent: ")).slice(12);
      return {
        stdout: actual[1] === "controller-1" ? controllerLines.replaceAll(userAgent, ua) : marketplaceLine,
        stderr: "",
      };
    }
    if (actual[1] === "daemonset") return json(data.daemonSet);
    if (actual[1] === "configmap") return json(actual[2].endsWith("-observability") ? data.collector : data.configMap);
    if (actual[1] === "deployment") return json(data.deployment);
    if (actual[1] === "pods")
      return json(actual[3] === "chase-sets-platform" ? data.marketplacePods : data.controllerPods);
    if (actual[1] === "service") return json(data.service);
    if (actual[1] === "ingress") return json(data.ingress);
    if (actual[1].startsWith("deployments,")) return json(data.inventory);
    throw new Error("unexpected fixture command");
  };
  if (overrides.chart) {
    const chartDir = join(outputDir, "infrastructure/helm/doks-ingress");
    mkdirSync(chartDir, { recursive: true });
    writeFileSync(join(chartDir, "ingress-nginx-values.yaml"), overrides.chart(chart));
  }
  return {
    calls,
    run: () =>
      main(
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
          root: overrides.chart ? outputDir : undefined,
          randomBytes: () => Buffer.from("0123456789abcdef", "hex"),
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      ),
    evidence: () => JSON.parse(readFileSync(output, "utf8")),
    cleanup: () => {
      process.exitCode = undefined;
      rmSync(outputDir, { recursive: true, force: true });
    },
  };
}

async function expectQualificationStop(fixture, code) {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(fixture.run()).resolves.toMatchObject({ overall: "INCONCLUSIVE", exitCode: 2 });
    expect(process.exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(`INCONCLUSIVE ${code}`);
    expect(fixture.calls.some((call) => call.command === "curl")).toBe(false);
    expect(fixture.evidence()).toEqual({
      schemaVersion: "ac5-logging-probe/v2",
      overall: "INCONCLUSIVE",
      refusal: code,
    });
  } finally {
    stderr.mockRestore();
    fixture.cleanup();
  }
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
    expect(() => assertReadOnlyKubectl(["--context=production", "get", "pods", "-A", "-o", "json"])).toThrow(
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

  it.each([
    [
      "Referer-only",
      controllerLines.replace(`"${userAgent}"`, `"${userAgent}" "https://example.test/?code=${sentinels[1]}"`),
    ],
    ["bare sentinel", `${controllerLines}\n2026-10-26T19:32:08Z controller diagnostic ${sentinels[0]}`],
  ])("fails only the controller sinks for a %s leak (F3)", (_name, lines) => {
    const rows = classify({ controllerLogs: complete(lines) });
    for (const name of ["ingressAccess", "ingressError", "controllerDefault"]) expect(rows[name].status).toBe("FAIL");
    expect(rows.web.status).toBe("PASS");
  });

  it("rejects sentinel-free request-scoped error text (F3)", () => {
    const rows = classify({
      controllerLogs: complete(
        `${controllerLines}\n2026-10-26T19:32:08Z [error] client intended to send too large body: request: POST /sign-in`,
      ),
    });
    expect(rows.ingressError.status).toBe("FAIL");
    expect(rows.ingressAccess.status).toBe("PASS");
  });

  it.each([0, 1, 2])("refuses a missing ingress R%i control and reports measured counts (F3)", (index) => {
    const lines = controllerLines.split("\n").filter((_line, position) => position !== index);
    const rows = classify({ controllerLogs: complete(lines.join("\n")) });
    expect(rows.ingressAccess.status).toBe("INCONCLUSIVE");
    expect(rows.ingressAccess.controls).toEqual({
      r1: index === 0 ? 0 : 1,
      r2: index === 1 ? 0 : 1,
      r3: index === 2 ? 0 : 1,
    });
    if (index === 2) expect(rows.ingressError.status).toBe("INCONCLUSIVE");
  });

  it("refuses duplicate ingress R1 controls and reports two (F3)", () => {
    const rows = classify({ controllerLogs: complete(`${controllerLines}\n${controllerLines.split("\n")[0]}`) });
    expect(rows.ingressAccess).toMatchObject({ status: "INCONCLUSIVE", controls: { r1: 2, r2: 1, r3: 1 } });
  });

  it.each([
    ["zero R1", "", 0],
    ["two R1", `${marketplaceLine}\n${marketplaceLine}`, 2],
    ["R2 present", `${marketplaceLine}\n2026-10-26T19:32:03Z GET /api/health 200 1 - 1 ms`, 1],
    ["R3 present", `${marketplaceLine}\n2026-10-26T19:32:06Z POST /sign-in 413 1 - 1 ms`, 1],
    ["R4 present", `${marketplaceLine}\n2026-10-26T19:32:07Z GET /probe 404 1 - 1 ms`, 1],
  ])("refuses marketplace %s and reports measured R1 count (F3)", (_name, lines, count) => {
    expect(classify({ marketplaceLogs: complete(lines) }).web).toMatchObject({
      status: "INCONCLUSIVE",
      controls: { r1: count },
    });
  });

  it.each(
    requests.flatMap(({ name }) => [
      [name, "wrong status", { status: 500 }],
      [name, "non-zero exit", { exit: 1 }],
    ]),
  )("refuses %s with %s despite present log controls (F3)", (name, _failure, change) => {
    const rows = classify({
      requests: requests.map((request) => (request.name === name ? { ...request, ...change } : request)),
    });
    if (name === "R1") expect(rows.web.status).toBe("INCONCLUSIVE");
    if (name !== "R4") expect(rows.ingressAccess.status).toBe("INCONCLUSIVE");
    if (name === "R3") expect(rows.ingressError.status).toBe("INCONCLUSIVE");
    if (name === "R4") expect(rows.controllerDefault.status).toBe("INCONCLUSIVE");
  });

  it("refuses serialization with a sentinel planted in qualification (F3)", () => {
    expect(() => serializeEvidence({ qualification: { pod: sentinels[1] }, rows: classify(), sentinels })).toThrow(
      "ac5_evidence_sentinel",
    );
  });

  it("writes the FAIL refusal stub and exits one when evidence contains a sentinel (F3, N4)", async () => {
    const fixture = mainFixture({
      change: (data) => {
        data.marketplacePods.items[0].metadata.name = "ac5-q-0123456789abcdef-r1";
      },
    });
    try {
      const result = await fixture.run();
      expect(result.overall).toBe("FAIL");
      expect(process.exitCode).toBe(1);
      expect(fixture.evidence()).toEqual({
        schemaVersion: "ac5-logging-probe/v2",
        overall: "FAIL",
        refusal: "evidence contained a probe sentinel and was not retained",
      });
      expect(JSON.stringify(fixture.evidence())).not.toContain("ac5-q-");
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    [
      "wrong workflow",
      "ac5_deploy_not_successful_for_merge",
      (data) => {
        data.deploy.workflowName = "Other";
      },
    ],
    [
      "head SHA mismatch",
      "ac5_deploy_not_successful_for_merge",
      (data) => {
        data.deploy.headSha = "c".repeat(40);
      },
    ],
    [
      "unfinished deploy",
      "ac5_deploy_not_successful_for_merge",
      (data) => {
        data.deploy.status = "in_progress";
      },
    ],
    [
      "failed deploy",
      "ac5_deploy_not_successful_for_merge",
      (data) => {
        data.deploy.conclusion = "failure";
      },
    ],
    [
      "newer deploy",
      "ac5_newer_deploy_in_progress",
      (data) => {
        data.deployRuns = [
          { workflowName: "Platform Deploy", status: "in_progress", createdAt: "2026-10-26T19:01:00Z" },
        ];
      },
    ],
    [
      "default backend inventory",
      "ac5_chart_inventory_forbidden_resource",
      (data) => {
        data.inventory.items = [{ metadata: { name: "test-default-backend" } }];
      },
    ],
    [
      "maintenance inventory",
      "ac5_chart_inventory_forbidden_resource",
      (data) => {
        data.inventory.items = [{ metadata: { name: "test-maintenance-config" } }];
      },
    ],
    [
      "stale Deployment",
      "ac5_marketplace_workload_incomplete",
      (data) => {
        data.deployment.status.observedGeneration = 0;
      },
    ],
    [
      "empty Deployment list",
      "ac5_marketplace_workload_incomplete",
      (data) => {
        data.deployment = { items: [] };
      },
    ],
    [
      "stale DaemonSet",
      "ac5_collector_rollout_incomplete",
      (data) => {
        data.daemonSet.status.observedGeneration = 0;
      },
    ],
    [
      "no ready marketplace pod",
      "ac5_ready_pods_missing",
      (data) => {
        data.marketplacePods.items[0].status.conditions = [];
      },
    ],
    [
      "no ready controller pod",
      "ac5_ready_pods_missing",
      (data) => {
        data.controllerPods.items[0].status.phase = "Pending";
      },
    ],
    [
      "incomplete pod list",
      "ac5_pod_list_incomplete",
      (data) => {
        data.marketplacePods.metadata = { continue: "next" };
      },
    ],
    [
      "digest mismatch",
      "ac5_marketplace_digest_mismatch",
      (data) => {
        const container = data.marketplacePods.items[0].status.containerStatuses[0];
        container.imageID = `registry.example/app@sha256:${"c".repeat(64)}`;
      },
    ],
    [
      "default logging enabled",
      "ac5_default_backend_logging_enabled",
      (data) => {
        data.configMap.data["enable-access-log-for-default-backend"] = "true";
      },
    ],
    [
      "stale access format",
      "ac5_controller_config_mismatch",
      (data) => {
        data.configMap.data["log-format-upstream"] = '"$request"';
      },
    ],
    [
      "error log enabled",
      "ac5_controller_config_mismatch",
      (data) => {
        data.configMap.data["error-log-path"] = "/var/log/nginx/error.log";
      },
    ],
    [
      "wildcard R4 host",
      "ac5_ingress_host_qualification_failed",
      (data) => {
        data.ingress.items[0].spec.rules.push({ host: "*.example.test" });
      },
    ],
    [
      "exact R4 host",
      "ac5_ingress_host_qualification_failed",
      (data) => {
        data.ingress.items[0].spec.rules.push({ host: "unknown.example.test" });
      },
    ],
    [
      "hostless rule",
      "ac5_ingress_host_qualification_failed",
      (data) => {
        data.ingress.items[0].spec.rules.push({});
      },
    ],
    [
      "missing staging host",
      "ac5_ingress_host_qualification_failed",
      (data) => {
        data.ingress.items = [];
      },
    ],
    [
      "no LoadBalancer IP",
      "ac5_ingress_host_qualification_failed",
      (data) => {
        data.service.status.loadBalancer.ingress = [];
      },
    ],
  ])("stops INCONCLUSIVE before requests for %s (F1, F2)", async (_name, code, change) => {
    await expectQualificationStop(mainFixture({ change }), code);
  });

  it("stops INCONCLUSIVE before requests for a non-ancestor fix (F1, F2)", async () => {
    await expectQualificationStop(mainFixture({ nonAncestor: true }), "ac5_fix_sha_not_ancestor");
  });

  it.each([
    [
      "chart default backend",
      "ac5_chart_default_backend_artifact_present",
      (chart) => `${chart}\ndefaultBackend: {}\n`,
    ],
    ["invalid chart config", "ac5_chart_config_invalid", (chart) => chart.replace("/dev/null", "/tmp/error.log")],
  ])("stops INCONCLUSIVE before requests for %s (F1, F2)", async (_name, code, chart) => {
    await expectQualificationStop(mainFixture({ chart }), code);
  });

  it.each([
    ["deploy", "gh", "view"],
    ["deploy_list", "gh", "list"],
    ["collector_rollout", "kubectl", "daemonset"],
    ["collector_config", "kubectl", "configmap", "chase-sets-platform-chase-sets-platform-observability"],
    ["marketplace_workload", "kubectl", "deployment"],
    ["marketplace_pods", "kubectl", "pods", "-n", "chase-sets-platform"],
    ["controller_pods", "kubectl", "pods", "-n", "ingress-nginx"],
    ["controller_config", "kubectl", "configmap", "ingress-nginx-controller"],
    ["controller_service", "kubectl", "service"],
    ["ingress_hosts", "kubectl", "ingress"],
    ["chart_inventory", "kubectl", "deployments,daemonsets,statefulsets,services,configmaps"],
  ])("stops INCONCLUSIVE before requests for denied %s access (F1, F2)", async (label, binary, ...prefix) => {
    await expectQualificationStop(
      mainFixture({
        accessFailure: (command, args) =>
          command === binary && prefix.every((value, index) => args[index + 1] === value),
      }),
      `ac5_${label}_read_incomplete`,
    );
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
    expect(classify({ collector: classifyCollectorConfig({ data: {} }) }).collector.status).toBe("INCONCLUSIVE");
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
    const fixture = mainFixture({ r4TlsFailure: true });
    try {
      const result = await fixture.run();
      expect(result.rows.controllerDefault.status).toBe("INCONCLUSIVE");
      expect(fixture.evidence().overall).toBe("INCONCLUSIVE");
      expect(fixture.calls.filter((call) => call.command === "curl")).toHaveLength(4);
      expect(fixture.calls.filter((call) => call.args[1] === "logs")).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
  });

  it("retains only qualified evidence fields and prints a bounded completion summary (N6, N11)", async () => {
    const fixture = mainFixture();
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(fixture.run()).resolves.toMatchObject({ overall: "PASS", exitCode: 0 });
      expect(Object.keys(fixture.evidence().qualification).sort()).toEqual([
        "controllerReady",
        "deployRunId",
        "fixMergeSha",
        "marketplaceReady",
        "mergeSha",
        "t0",
        "t1",
      ]);
      expect(stdout).toHaveBeenCalledExactlyOnceWith(
        "AC5 PASS web=PASS ingressAccess=PASS ingressError=PASS controllerDefault=PASS collector=PASS",
      );
    } finally {
      stdout.mockRestore();
      fixture.cleanup();
    }
  });

  it("records an overlong post-send window as INCONCLUSIVE, not FAIL (F1)", async () => {
    const fixture = mainFixture({ requestDurationMs: 26_000 });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(fixture.run()).resolves.toMatchObject({ overall: "INCONCLUSIVE", exitCode: 2 });
      expect(fixture.evidence()).toMatchObject({ overall: "INCONCLUSIVE", refusal: "ac5_probe_window_too_long" });
      expect(stderr).toHaveBeenCalledExactlyOnceWith("INCONCLUSIVE ac5_probe_window_too_long");
      expect(fixture.calls.filter((call) => call.command === "curl")).toHaveLength(4);
    } finally {
      stderr.mockRestore();
      fixture.cleanup();
    }
  });

  it("computes an explicit overall verdict rather than exiting zero for a red row (F13, F14)", () => {
    expect(["PASS", "FAIL", "INCONCLUSIVE"].map(verdictExitCode)).toEqual([0, 1, 2]);
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
