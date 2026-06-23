import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL(".", import.meta.url));

function readStackFile(path: string) {
  return readFileSync(join(root, "stack", path), "utf8");
}

function readRepoFile(path: string) {
  return readFileSync(join(root, "..", "..", path), "utf8");
}

function extractCheckoutEventNames(contractSource: string) {
  return [...contractSource.matchAll(/eventName: "(checkout\.[^"]+)"/g)].map((match) => match[1]);
}

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

  it("provisions Grafana datasources, dashboard, and alert rules", () => {
    expect(readStackFile("grafana/provisioning/datasources/datasources.yml")).toContain("Prometheus");
    expect(readStackFile("grafana/provisioning/datasources/datasources.yml")).toContain("Loki");
    expect(readStackFile("grafana/provisioning/datasources/datasources.yml")).toContain("Tempo");
    expect(readStackFile("grafana/dashboards/platform-api-overview.json")).toContain("Platform API Overview");
    expect(readStackFile("grafana/dashboards/platform-api-overview.json")).toContain("UCP operation rate");
    expect(readStackFile("grafana/dashboards/public-presence-waitlist.json")).toContain(
      "Public Presence Waitlist Funnel",
    );
    expect(readStackFile("grafana/dashboards/public-presence-waitlist.json")).toContain(
      "chase_sets_public_presence_waitlist_events_total",
    );
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain("Projection Freshness");
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain(
      "chase_sets_projection_freshness_evaluations_total",
    );
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain("Route wiring failures");
    expect(readStackFile("grafana/dashboards/projection-freshness.json")).toContain("Projection lag pending rows");
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
      "UCP signature verification failures",
    );
    expect(readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml")).toContain(
      "Checkout launch observability alert events",
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
    expect(readStackFile("grafana/provisioning/alerting/catalog-integration-alerts.yml")).toContain(
      "Catalog option query failures",
    );
  });

  it("keeps Grafana alert rule UIDs within the provisioning limit", () => {
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
    for (const { fileName, uid } of uids) {
      expect(uid.length, `${fileName}: ${uid}`).toBeLessThanOrEqual(40);
    }
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
