import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChannelPublicationDetailPage,
  ChannelPublicationListPage,
  type ChannelPublicationDetailPageState,
  type ChannelPublicationListPageState,
} from "../ui/publication-pages";
import type { ChannelPublicationConnectionDetail } from "../domain/contracts";

describe("channel-publication-settings-route", () => {
  it("renders every list loading, empty, error, forbidden and success state through design-system components", () => {
    const states: readonly ChannelPublicationListPageState[] = [
      { kind: "loading" },
      { kind: "authorization-forbidden" },
      { kind: "command-error", message: "synthetic-error" },
      { kind: "ready", connections: [] },
      {
        kind: "ready",
        connections: [
          {
            connectionId: "connection-1",
            providerKey: "synthetic-provider",
            environment: "sandbox",
            connectionStatus: "active",
            settingsState: "configured",
            reviewCount: 2,
          },
        ],
      },
    ];
    const output = states.map((state) => renderToStaticMarkup(<ChannelPublicationListPage state={state} />));
    expect(output[0]).toContain("Loading channel publication settings");
    expect(output[1]).toContain("Publication access required");
    expect(output[2]).toContain("synthetic-error");
    expect(output[3]).toContain("No channel connections");
    expect(output[4]).toContain("synthetic-provider");
  });

  it("renders settings missing/present, queue empty/paged/incomplete, conflict, foreign-account and command error", () => {
    const ready = detail();
    const incomplete = detail({
      mappingReview: {
        items: [
          {
            connectionId: "connection-1",
            dimension: "category",
            sourceKey: "catalog-category:cards",
            targetKey: null,
            confidenceTier: "high",
            reviewStatus: "proposed",
            provenance: "compose-discovered",
            evidence: { listingId: "listing-1", derivedFrom: "assigned category cards" },
            lastStreamVersion: 2,
          },
        ],
        nextCursor: "next",
        completeness: { kind: "incomplete", reason: "synthetic-incomplete" },
      },
    });
    const states: readonly ChannelPublicationDetailPageState[] = [
      { kind: "loading" },
      { kind: "authorization-forbidden" },
      { kind: "foreign-account" },
      { kind: "command-error", message: "synthetic-command-error", detail: ready },
      { kind: "stale-version-conflict", detail: ready },
      { kind: "ready", detail: ready },
      { kind: "ready", detail: incomplete },
    ];
    const output = states.map((state) => renderToStaticMarkup(<ChannelPublicationDetailPage state={state} />));
    expect(output[2]).toContain("Channel connection not found");
    expect(output[3]).toContain("synthetic-command-error");
    expect(output[4]).toContain("Settings changed");
    expect(output[5]).toContain("Settings are required");
    expect(output[5]).toContain("No mappings to review");
    expect(output[6]).toContain("synthetic-incomplete");
    expect(output[6]).toContain("Next mappings");
  });
});

function detail(overrides: Partial<ChannelPublicationConnectionDetail> = {}): ChannelPublicationConnectionDetail {
  return {
    connection: {
      connectionId: "connection-1",
      providerKey: "synthetic-provider",
      environment: "sandbox",
      connectionStatus: "active",
      settingsState: "missing",
      reviewCount: 0,
    },
    settings: null,
    mappingReview: { items: [], nextCursor: null, completeness: { kind: "complete", total: 0 } },
    configurationStreamVersion: 0,
    ...overrides,
  };
}
