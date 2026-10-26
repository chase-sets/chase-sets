import { describe, expect, it } from "vitest";
import {
  buildCurlRequestArgs,
  buildKubectlLogsArgs,
  buildProbeWindow,
  classifyAc5Rows,
  classifyCollectorConfig,
  selectReadyPods,
  serializeEvidence,
  toRfc3339,
} from "./ac5-logging-probe.mjs";

const sentinel = "ac5-synthetic-7f0c";

function complete(text) {
  return { complete: true, text };
}

const marketplace = "2026-10-26T19:32:00Z GET /sign-in 200 120 - 1 ms";
const controller = [
  "2026-10-26T19:32:00Z GET /sign-in 200",
  "2026-10-26T19:32:03Z GET /api/health 200",
  "2026-10-26T19:32:06Z POST /sign-in 413",
  "2026-10-26T19:32:07Z GET /probe 404",
  "2026-10-26T19:32:06Z client intended to send too large body: request: POST /sign-in",
].join("\n");

describe("AC5 logging probe", () => {
  it("builds RFC3339 UTC windows and kubectl logs argv without PowerShell object coercion", () => {
    expect(toRfc3339("2026-10-26T19:32:00.867213Z")).toBe("2026-10-26T19:32:00Z");
    expect(buildProbeWindow({ r1At: "2026-10-26T19:32:00.867213Z", r4At: "2026-10-26T19:32:07.146903Z" })).toEqual({
      t0: "2026-10-26T19:31:55Z",
      t1: "2026-10-26T19:32:22Z",
    });
    expect(
      buildKubectlLogsArgs({ namespace: "ingress-nginx", pod: "controller-abc", since: "2026-10-26T19:31:55Z" }),
    ).toEqual([
      "logs",
      "controller-abc",
      "--namespace",
      "ingress-nginx",
      "--timestamps",
      "--since-time=2026-10-26T19:31:55Z",
      "--limit-bytes=1048576",
    ]);
    expect(
      buildCurlRequestArgs({ host: "ac5-r4.example.test", path: "/probe", sentinel, resolveIP: "192.0.2.10" }),
    ).toEqual(
      expect.arrayContaining([
        "--resolve",
        "ac5-r4.example.test:443:192.0.2.10",
        "https://ac5-r4.example.test/probe?probe=ac5-synthetic-7f0c",
      ]),
    );
  });

  it("selects only running ready controller and marketplace pods", () => {
    const list = {
      items: [
        {
          metadata: { name: "ready", namespace: "n", labels: { "app.kubernetes.io/name": "marketplace" } },
          status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
        },
        {
          metadata: { name: "pending", namespace: "n", labels: { "app.kubernetes.io/name": "marketplace" } },
          status: { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] },
        },
        {
          metadata: { name: "other", namespace: "n", labels: { "app.kubernetes.io/name": "worker" } },
          status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
        },
      ],
    };
    expect(selectReadyPods(list, { namespace: "n", role: "marketplace" })).toEqual(["ready"]);
    expect(selectReadyPods(list, { namespace: "n", role: "controller" })).toEqual([]);
  });

  it("classifies every AC5 sink row PASS after the repaired controls are present", () => {
    expect(
      classifyAc5Rows({
        marketplaceLogs: complete(marketplace),
        controllerLogs: complete(controller),
        sentinels: [sentinel],
        collector: { traceDeletes: true, logDeletes: true },
      }),
    ).toMatchObject({
      web: { status: "PASS" },
      ingressAccess: { status: "PASS" },
      ingressError: { status: "PASS" },
      controllerDefault: { status: "PASS" },
      collector: { status: "PASS" },
    });
  });

  it("turns the query/referrer sentinel mutant red and incomplete reads inconclusive", () => {
    const mutant = classifyAc5Rows({
      marketplaceLogs: complete(`${marketplace}?token=${sentinel}`),
      controllerLogs: complete(controller),
      sentinels: [sentinel],
      collector: { traceDeletes: true, logDeletes: true },
    });
    expect(mutant.web.status).toBe("FAIL");
    const incomplete = classifyAc5Rows({
      marketplaceLogs: { complete: false, text: marketplace },
      controllerLogs: complete(controller),
      sentinels: [sentinel],
      collector: { traceDeletes: true, logDeletes: true },
    });
    expect(Object.values(incomplete).every((result) => result.status === "INCONCLUSIVE")).toBe(true);
  });

  it("serializes bounded evidence without sentinels or raw log payloads", () => {
    const output = serializeEvidence({
      qualification: { mergeSha: "a".repeat(40) },
      requests: [{ name: "R1", method: "GET", path: "/sign-in", status: 200, exit: 0 }],
      reads: [{ namespace: "n", pod: "p", exit: 0, bytes: 10, complete: true, timedOut: false }],
      rows: { web: { status: "PASS" } },
    });
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain("2026-10-26T19:32:00Z GET");
    expect(output).toContain('"web"');
  });

  it("requires both collector statement sets to retain the four delete attributes", () => {
    const config = {
      data: {
        traces: "drop http.target http.url url.full url.query",
        logs: "drop http.target http.url url.full url.query",
      },
    };
    expect(classifyCollectorConfig(config)).toEqual({ traceDeletes: true, logDeletes: true });
    expect(classifyCollectorConfig({ data: { traces: "drop url.full url.query" } })).toEqual({
      traceDeletes: false,
      logDeletes: false,
    });
  });
});
