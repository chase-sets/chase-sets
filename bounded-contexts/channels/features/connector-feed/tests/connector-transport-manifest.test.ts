import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectorInboundSchemaMigrations, connectorInboundSchemaSql } from "../read-model/inbound-schema";
import { connectorFeedSchemaMigrations } from "../read-model/schema";

describe("connector-feed-bootstrap-and-manifest", () => {
  it("ships every boot statement in an ordered migration, including the separately retained identity and payload", () => {
    const migrations = connectorInboundSchemaMigrations.flatMap((migration) => migration.statements);
    expect(connectorInboundSchemaSql).toBe(
      migrations.map((statement) => statement.replace("INDEX CONCURRENTLY", "INDEX")).join(";\n") + ";",
    );
    for (const statement of migrations)
      expect(connectorInboundSchemaSql).toContain(statement.replace("INDEX CONCURRENTLY", "INDEX"));
    expect(
      connectorInboundSchemaMigrations[0]?.migrationId.localeCompare(
        connectorFeedSchemaMigrations.at(-1)?.migrationId ?? "",
      ),
    ).toBeGreaterThan(0);
    expect(connectorInboundSchemaSql).toContain("channel_connector_inbound_events");
    expect(connectorInboundSchemaSql).toContain("channel_connector_inbound_payloads");
    expect(connectorInboundSchemaSql).toContain("(connection_id, event_kind, admitted_sequence)");
    expect(connectorInboundSchemaSql).toContain("(inbound_kind, received_at, provider_event_id)");
    expect(connectorInboundSchemaSql).toContain("served_poll_window_seconds");
    expect(connectorInboundSchemaSql).not.toMatch(/DELETE|TRUNCATE|DROP/);
  });
  it("enrolls each new persisted proof in Channels DB only and imports the existing inbox helper", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(manifest.dependencies["@chase-sets/provider-webhook-inbox"]).toBe("workspace:*");
    for (const file of [
      "connector-inbound",
      "connector-steady-state",
      "connector-producer",
      "connector-liveness-authority-write",
      "connector-liveness-authority-read",
      "connector-liveness-candidates",
      "connector-liveness-policy-identity",
    ]) {
      const path = `features/connector-feed/tests/${file}.db.test.ts`;
      expect(manifest.scripts["test:db"].split(" ")).toContain(path);
      expect(manifest.scripts["test:unit"]).toContain(`--exclude ${path}`);
    }
  });
});
