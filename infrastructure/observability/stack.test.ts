import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { recordProjectionStatus } from "./index";

const root = fileURLToPath(new URL(".", import.meta.url));

function readStackFile(path: string) {
  return readFileSync(join(root, "stack", path), "utf8");
}

function readObservabilityFile(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function readRepoFile(path: string) {
  return readFileSync(join(root, "..", "..", path), "utf8");
}

function extractCheckoutEventNames(contractSource: string) {
  return [...contractSource.matchAll(/eventName: "(checkout\.[^"]+)"/g)].map((match) => match[1]);
}

type DurableAlertRule = {
  uid: string;
  condition: string;
  for: string;
  noDataState: string;
  execErrState: string;
  labels: Record<string, string>;
  data: Array<{
    refId: string;
    datasourceUid: string;
    model: {
      expr?: string;
      instant?: boolean;
      expression?: string;
      type?: string;
      reducer?: string;
      conditions?: Array<{ evaluator: { type: string; params: number[] } }>;
    };
  }>;
};

function durableAlertWiring(ruleSource: string, contactSource: string) {
  const provisioning = parse(ruleSource) as { groups: Array<{ interval: string; rules: DurableAlertRule[] }> };
  const matches = provisioning.groups.flatMap((group) =>
    group.rules
      .filter((rule) => rule.uid === "projection-durable-stream-attention")
      .map((rule) => ({ rule, interval: group.interval })),
  );
  expect(matches).toHaveLength(1);
  const { rule, interval } = matches[0]!;
  const query = rule.data.find((item) => item.refId === "A")!;
  expect(query.datasourceUid).toBe("Prometheus");
  expect(query.model.instant).toBe(true);
  expect(rule.condition).toBe("C");
  expect(rule.data.find((item) => item.refId === "B")?.model).toMatchObject({
    type: "reduce",
    expression: "A",
    reducer: "last",
  });
  const threshold = rule.data.find((item) => item.refId === "C")!.model;
  expect(threshold).toMatchObject({
    type: "threshold",
    expression: "B",
    conditions: [{ evaluator: { type: "gt", params: [0] } }],
  });
  expect(rule.for).toBe("2m");
  expect(interval).toBe("1m");
  expect(rule.noDataState).toBe("Alerting");
  expect(rule.execErrState).toBe("Alerting");
  const contact = parse(contactSource.replace("${alert_emails}", "synthetic-operator@example.invalid")) as {
    contactPoints: Array<{ orgId: number; name: string; receivers: Array<{ uid: string; type: string }> }>;
    policies: Array<{ orgId: number; receiver: string; group_by: string[] }>;
  };
  expect(contact.policies).toHaveLength(1);
  expect(contact.policies[0]).toMatchObject({ orgId: 1, receiver: "chase-sets-platform-alert-email" });
  expect(contact.policies[0]!.group_by).toContain("environment");
  expect(
    contact.contactPoints.filter(
      (point) => point.orgId === contact.policies[0]!.orgId && point.name === contact.policies[0]!.receiver,
    ),
  ).toEqual([
    expect.objectContaining({
      receivers: [expect.objectContaining({ uid: "chase-sets-platform-alert-email", type: "email" })],
    }),
  ]);
  return { rule, interval, expression: `${query.model.expr} > ${threshold.conditions![0]!.evaluator.params[0]}` };
}

describe("durable projection stream alert proof", () => {
  const ruleSource = () => readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml");
  const contactSource = () =>
    readRepoFile("infrastructure/digitalocean/observability/templates/contact-points.yml.tftpl");

  it("requires the deployed rule and existing environment-separated receiver mapping", () => {
    durableAlertWiring(ruleSource(), contactSource());
    expect(() =>
      durableAlertWiring(
        ruleSource().replace("uid: projection-durable-stream-attention", "uid: synthetic-removed-rule"),
        contactSource(),
      ),
    ).toThrow();
    expect(() =>
      durableAlertWiring(
        ruleSource(),
        contactSource().replace("receiver: chase-sets-platform-alert-email", "receiver: synthetic-unmapped-receiver"),
      ),
    ).toThrow();
    for (const collector of [
      readStackFile("collector-config.yml"),
      readRepoFile("infrastructure/digitalocean/observability/templates/collector-config.yml.tftpl"),
    ]) {
      const config = parse(collector);
      expect(config.exporters.prometheus.resource_to_telemetry_conversion.enabled).toBe(true);
      expect(config.service.pipelines.metrics.exporters).toContain("prometheus");
    }
    const locals = readRepoFile("infrastructure/digitalocean/observability/locals.tf");
    expect(locals).toContain("stack_file_exclusions = toset([])");
    expect(locals).toContain("generated_alerting_files = var.grafana_smtp_enabled ?");
    expect(locals).toContain("merge(local.stack_files, local.generated_stack_files, local.generated_alerting_files)");
    const callers = readRepoFile("deployables/platform-worker/src/main.ts");
    expect(callers).toContain("createWorkerObserver(logger, workerKind, undefined, recordProjectionStatus)");
    expect(callers).toContain("createWorkerObserver(logger, workerKind, group.name, recordProjectionStatus)");
  });

  it("evaluates real published samples with Prometheus against the checked-in expression and window", async () => {
    const { rule, interval, expression } = durableAlertWiring(ruleSource(), contactSource());
    const cases = [
      { name: "healthy-zero", blocked: 0, poison: 0, firing: false },
      { name: "blocked-only-flat-no-read-traffic", blocked: 1, poison: 0, firing: true },
      { name: "active-poison-only", blocked: 0, poison: 1, firing: true },
      { name: "transient-error-without-durable-attention", blocked: 0, poison: 0, firing: false },
      { name: "recovery", blocked: 1, poison: 1, firing: true, recover: true },
      { name: "stale-observation", blocked: 1, poison: 0, firing: false, stale: true },
      { name: "missing-publication", blocked: 1, poison: 0, firing: false, missing: true },
      { name: "staging-is-not-production", blocked: 1, poison: 0, firing: true, environment: "staging" },
      { name: "local-is-not-production", blocked: 1, poison: 0, firing: false, environment: "local" },
    ];
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
    });
    metrics.disable();
    metrics.setGlobalMeterProvider(provider);
    const now = vi.spyOn(Date, "now");
    const series = new Map<string, number[]>();
    try {
      for (let minute = 0; minute <= 8; minute += 1) {
        now.mockReturnValue(minute * 60_000);
        for (const control of cases) {
          if (control.missing || (control.stale && minute > 0)) continue;
          vi.stubEnv("DEPLOYMENT_ENVIRONMENT", control.environment ?? "production");
          const recovered = control.recover && minute >= 4;
          recordProjectionStatus({
            targetContextName: "synthetic-context",
            projectionName: control.name,
            blockedStreamCount: recovered ? 0 : control.blocked,
            poisonEventCount: recovered ? 0 : control.poison,
          });
        }
        await provider.forceFlush();
        const exported = exporter
          .getMetrics()
          .at(-1)!
          .scopeMetrics.flatMap((scope) => scope.metrics);
        for (const metric of exported) {
          for (const point of metric.dataPoints) {
            const labels = Object.entries(point.attributes)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(",");
            const key = `${metric.descriptor.name}{${labels}}`;
            const values = series.get(key) ?? [];
            values.push(point.value as number);
            series.set(key, values);
          }
        }
      }
    } finally {
      now.mockRestore();
      vi.unstubAllEnvs();
      await provider.shutdown();
      metrics.disable();
    }
    const expected = (minute: number) =>
      cases
        .filter((control) => control.firing && !(control.recover && minute >= 4))
        .map((control) => ({
          exp_labels: {
            ...rule.labels,
            environment: control.environment ?? "production",
            target_context: "synthetic-context",
            projection: control.name,
          },
          exp_annotations: {},
        }));
    const scratchRoot = join(root, "..", "..", ".tmp");
    mkdirSync(scratchRoot, { recursive: true });
    const proof = mkdtempSync(join(scratchRoot, "projection-alert-"));
    writeFileSync(
      join(proof, "rules.yml"),
      stringify({
        groups: [
          {
            name: "synthetic-durable-alert-proof",
            interval,
            rules: [{ alert: rule.uid, expr: expression, for: rule.for, labels: rule.labels }],
          },
        ],
      }),
    );
    writeFileSync(
      join(proof, "tests.yml"),
      stringify({
        rule_files: ["rules.yml"],
        evaluation_interval: interval,
        tests: [
          {
            name: "synthetic-publication-to-checked-in-rule",
            interval,
            input_series: [...series].map(([name, values]) => ({ series: name, values: values.join(" ") })),
            alert_rule_test: [0, 1, 2, 3, 4, 5, 8].map((minute) => ({
              eval_time: `${minute}m`,
              alertname: rule.uid,
              exp_alerts: minute < 2 ? [] : expected(minute),
            })),
            promql_expr_test: [3, 8].flatMap((minute) =>
              ["stale-observation", "missing-publication", "healthy-zero"].map((name) => ({
                expr: `(${rule.data.find((item) => item.refId === "A")!.model.expr}) and on (projection) {projection="${name}"}`,
                eval_time: `${minute}m`,
                exp_samples:
                  name === "healthy-zero"
                    ? [
                        {
                          labels:
                            '{environment="production",projection="healthy-zero",target_context="synthetic-context"}',
                          value: 0,
                        },
                      ]
                    : [],
              })),
            ),
          },
        ],
      }),
    );
    // Match the retained stack's Prometheus engine, without a server, credentials or network access.
    const output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "/bin/promtool",
        "--volume",
        `${proof}:/proof:ro`,
        "--workdir",
        "/proof",
        "prom/prometheus:v2.55.1",
        "test",
        "rules",
        "tests.yml",
      ],
      { encoding: "utf8" },
    );
    writeFileSync(join(proof, "promtool.log"), output);
    expect(output).toContain("SUCCESS");
  });
});

describe("observability stack contracts", () => {
  it("accepts OTLP and exports all three signal pipelines", () => {
    const config = readStackFile("collector-config.yml");

    expect(config).toContain("receivers:");
    expect(config).toContain("otlp:");
    expect(config).toContain("traces:");
    expect(config).toContain("metrics:");
    expect(config).toContain("logs:");
    expect(config).toContain("filelog/platform_api");
    expect(config).toContain("otlp/tempo");
    expect(config).toContain("otlphttp/loki");
    expect(config).toContain("prometheus:");
  });

  it("labels local Prometheus scrape data with bounded environment and stack labels", () => {
    const config = readStackFile("prometheus.yml");

    expect(config).toContain("target_label: deployment_environment");
    expect(config).toContain("replacement: local");
    expect(config).toContain("target_label: chase_sets_observability_stack");
    expect(config).toContain("replacement: single-shared-stack");
  });

  it("defines the DOKS collector contract for k8s-native signals into the shared stack", () => {
    const config = readRepoFile("infrastructure/helm/platform/templates/observability-config.yaml");
    const workloads = readRepoFile("infrastructure/helm/platform/templates/observability-workloads.yaml");
    const readme = readObservabilityFile("kubernetes/README.md");

    expect(config).toContain("kubeletstats:");
    expect(config).toContain("kube-state-metrics");
    expect(config).toContain("k8sattributes:");
    expect(config).toContain("deployment.environment");
    expect(config).toContain("${env:CHASE_SETS_DEPLOYMENT_ENVIRONMENT}");
    expect(config).toContain("k8s.cluster.name");
    expect(config).toContain("chase_sets.observability_stack");
    expect(config).toContain("otlphttp/central_stack");
    expect(config).toContain("X-Chase-Sets-Observability-Token: ${env:CHASE_SETS_OTLP_TOKEN}");
    expect(config).not.toContain("account.id");
    expect(config).not.toContain("payment.id");
    expect(config).not.toContain("session.id");
    expect(config).toContain('delete_key(attributes, "db.connection_string")');
    expect(config).toContain('delete_key(attributes, "url.full")');
    expect(config).toContain('delete_key(attributes, "user_agent.original")');
    expect(workloads).toContain("kind: DaemonSet");
    expect(workloads).toContain("checksum/config:");
    expect(workloads).toContain(".Values.observability.kubeStateMetrics.image.repository");
    expect(readme).toContain("single shared Chase Sets observability stack");
    expect(readme).toContain("platform Helm release");
  });

  it("provisions Grafana datasources, dashboard, and alert rules", () => {
    expect(readStackFile("grafana/provisioning/datasources/datasources.yml")).toContain("Prometheus");
    expect(readStackFile("grafana/provisioning/datasources/datasources.yml")).toContain("Loki");
    expect(readStackFile("grafana/provisioning/datasources/datasources.yml")).toContain("Tempo");
    expect(readStackFile("grafana/dashboards/platform-api-overview.json")).toContain("Platform API Overview");
    expect(readStackFile("grafana/dashboards/platform-api-overview.json")).toContain("UCP operation rate");
    expect(readStackFile("grafana/dashboards/platform-api-overview.json")).toContain(
      "Stripe webhook ingestion classes",
    );
    expect(readStackFile("grafana/dashboards/public-presence-waitlist.json")).toContain(
      "Public Presence Waitlist Funnel",
    );
    expect(readStackFile("grafana/dashboards/public-presence-waitlist.json")).toContain(
      "chase_sets_public_presence_waitlist_events_total",
    );
    expect(readStackFile("grafana/dashboards/public-presence-waitlist.json")).toContain(
      "Campaign funnel by channel (visit -> signup -> Discord CTA -> referral share)",
    );
    expect(readStackFile("grafana/dashboards/public-presence-waitlist.json")).toContain(
      "Discord CTA click-through and referral share, last 24h",
    );
    expect(readStackFile("grafana/dashboards/public-presence-waitlist.json")).toContain("/campaign-analytics");
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain("Projection Freshness");
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain(
      "chase_sets_projection_freshness_evaluations_total",
    );
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain("Route wiring failures");
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain("Projection lag pending rows");
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain("checkout session SLO violations");
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain(
      "Readiness and semantic handoff failures",
    );
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain(
      "chase_sets_post_write_consistency_events_total",
    );
    expect(readStackFile("grafana/dashboards/checkout-observability.json")).toContain("Checkout Observability");
    expect(readStackFile("grafana/dashboards/checkout-observability.json")).toContain(
      "chase_sets_checkout_observability_events_total",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml")).toContain(
      "Platform API elevated 5xx rate",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml")).toContain(
      "Commercial Terms active policy overlap observed",
    );
    expect(readStackFile("grafana/provisioning/alerting/kubernetes-observability-alerts.yml")).toContain(
      "Staging Kubernetes telemetry missing",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml")).toContain(
      "UCP signature verification failures",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml")).toContain(
      "Checkout observability alert events",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml")).toContain(
      "Checkout side-effect boundary violation",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml")).toContain(
      "Checkout freshness timeout rate above SLO",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml")).toContain(
      "Projection freshness pending rows with projection errors",
    );
    expect(readStackFile("grafana/dashboards/projection-wake-pipeline.json")).toContain("Projection Wake Pipeline");
    expect(readStackFile("grafana/dashboards/projection-wake-pipeline.json")).toContain(
      "chase_sets_projection_wake_intents_total",
    );
    expect(readStackFile("grafana/dashboards/projection-wake-pipeline.json")).toContain(
      "chase_sets_projection_wake_intent_enqueue_outcomes_total",
    );
    expect(readStackFile("grafana/dashboards/projection-wake-pipeline.json")).toContain(
      "chase_sets_projection_freshness_wake_enqueue_duration_ms",
    );
    expect(readStackFile("grafana/dashboards/projection-wake-pipeline.json")).toContain(
      "chase_sets_event_store_append_advisory_lock_hold_duration_ms",
    );
    expect(readStackFile("grafana/dashboards/catalog-integration-control-plane.json")).toContain(
      "Catalog Integration Control Plane",
    );
    expect(readStackFile("grafana/dashboards/catalog-integration-control-plane.json")).toContain(
      "chase_sets_catalog_control_plane_events_total",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-worker-wake-alerts.yml")).toContain(
      "Projection wake relay fan-out failures",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-worker-wake-alerts.yml")).toContain(
      "Projection wake hot lane queue age p95 above SLO",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-worker-wake-alerts.yml")).toContain(
      "Reaction append advisory-lock hold p95 above SLO",
    );
    expect(readStackFile("grafana/provisioning/alerting/catalog-integration-alerts.yml")).toContain(
      "Catalog option query failures",
    );
    expect(readStackFile("grafana/provisioning/alerting/stripe-webhook-alerts.yml")).toContain(
      "Sustained Stripe webhook signature failures",
    );
    expect(readStackFile("grafana/provisioning/alerting/stripe-webhook-alerts.yml")).toContain(
      "Stripe webhook handler-failure spike",
    );
    expect(readStackFile("grafana/provisioning/alerting/stripe-webhook-alerts.yml")).toContain(
      "Stripe webhook retry/dead-letter growth",
    );
  });

  it("keeps Grafana alert rule UIDs unique and within the provisioning limit", () => {
    const alertingDir = join(root, "stack", "grafana", "provisioning", "alerting");
    const uids = readdirSync(alertingDir)
      .filter((fileName) => fileName.endsWith(".yml"))
      .flatMap((fileName) => {
        const source = readFileSync(join(alertingDir, fileName), "utf8");

        return [...source.matchAll(/^\s+- uid: (.+)$/gm)].map((match) => ({
          fileName,
          uid: match[1],
        }));
      });

    expect(uids.length).toBeGreaterThan(0);
    expect(new Set(uids.map(({ uid }) => uid)).size).toBe(uids.length);
    for (const { fileName, uid } of uids) {
      expect(uid.length, `${fileName}: ${uid}`).toBeLessThanOrEqual(40);
    }
  });

  it("retires stale Grafana alert imports before provisioning replacement rules", () => {
    const platformApiAlerts = readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml");

    expect(platformApiAlerts).toContain("deleteRules:");
    expect(platformApiAlerts).toContain("uid: checkout-operator-alert-events");
    expect(platformApiAlerts).toContain("uid: checkout-observability-alert-events");
    expect(platformApiAlerts).not.toContain("- uid: checkout-operator-alert-events");
  });

  it("keeps the Checkout dashboard aligned with the typed observability profiles", () => {
    const dashboard = JSON.parse(readStackFile("grafana/dashboards/checkout-observability.json")) as {
      title: string;
      tags: string[];
      panels: unknown[];
      templating: { list: readonly { query?: string }[] };
    };
    const dashboardSource = JSON.stringify(dashboard);
    const contractSource = readRepoFile(
      "bounded-contexts/checkout/features/sessions/api/checkout-observability-contract.ts",
    );
    const eventNames = extractCheckoutEventNames(contractSource);

    expect(dashboard.title).toBe("Checkout Observability");
    expect(dashboard.tags).toEqual(expect.arrayContaining(["checkout", "observability"]));
    expect(dashboard.tags).not.toContain("launch");
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(6);
    expect(new Set(eventNames).size).toBe(eventNames.length);
    expect(eventNames.length).toBeGreaterThan(20);

    for (const eventName of eventNames) {
      expect(dashboardSource, eventName).toContain(eventName);
    }

    expect(dashboardSource).toContain("chase_sets_checkout_observability_events_total");
    expect(dashboardSource).toContain("operator_signal_required");
    expect(dashboardSource).toContain("capability_decision");
    expect(dashboardSource).toContain("side_effect_status");
    expect(dashboardSource).toContain("support_reference_present");
    expect(dashboardSource).not.toContain("production_proof");
    expect(dashboardSource).not.toContain("fresh_state_cleanup_verified");
    expect(dashboardSource).not.toContain("release_run_id");
    expect(dashboardSource).not.toContain("canary_final_state");
    expect(dashboardSource).not.toContain("promotion_decision");
    expect(dashboardSource).not.toContain("raw-after-write");
    expect(dashboardSource).not.toContain("provider-payload");
    expect(dashboardSource).not.toContain("checkout-session-id");
    expect(dashboardSource).not.toContain("account-id");
    expect(dashboardSource).not.toContain("event-id");
    expect(dashboardSource).not.toContain("full-url");
    expect(dashboardSource).not.toContain("card-data");
    expect(dashboardSource).not.toContain("bank-data");
    expect(dashboardSource).not.toContain("sensitive-risk-signal");
  });
});
