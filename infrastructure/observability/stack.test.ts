import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL(".", import.meta.url));

function readStackFile(path: string) {
  return readFileSync(join(root, "stack", path), "utf8");
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
    expect(readStackFile("grafana/provisioning/datasources/datasources.yml"))
      .toContain("Prometheus");
    expect(readStackFile("grafana/provisioning/datasources/datasources.yml"))
      .toContain("Loki");
    expect(readStackFile("grafana/provisioning/datasources/datasources.yml"))
      .toContain("Tempo");
    expect(readStackFile("grafana/dashboards/platform-api-overview.json"))
      .toContain("Platform API Overview");
    expect(readStackFile("grafana/dashboards/platform-api-overview.json"))
      .toContain("UCP operation rate");
    expect(readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml"))
      .toContain("Platform API elevated 5xx rate");
    expect(readStackFile("grafana/provisioning/alerting/platform-api-alerts.yml"))
      .toContain("UCP signature verification failures");
  });
});
