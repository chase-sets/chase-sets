import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutboundOperationLogPanel } from "../ui/operation-log-panel";

const summary = {
  completeness: { kind: "complete" as const, total: 1 },
  succeeded: 1,
  failed: 0,
  pending: 0,
  inFlight: 0,
  blocked: 0,
  inlineEventToProviderAckMs: { p50: 1_000, p95: 1_000, p99: 1_000 },
  claimedEventToProviderAckMs: { p50: null, p95: null, p99: null },
};

const operation = {
  operationId: "operation-a",
  channelListingId: "channel-listing-a",
  listingId: "listing-a",
  operationKind: "publish" as const,
  status: "succeeded" as const,
  terminalReason: null,
  rejectionCode: null,
  attemptCount: 1,
  linkWriteState: "applied" as const,
  sourceOccurredAt: "2026-09-07T19:00:00.000Z",
  enqueuedAt: "2026-09-07T19:00:00.500Z",
  terminalAt: "2026-09-07T19:00:01.000Z",
  eventToEnqueueMs: 500,
  enqueueToTerminalMs: 500,
  eventToProviderAckMs: 1_000,
};

describe("channels-connection-detail operation log rendering", () => {
  it("renders populated metrics and rows through canonical operational components", () => {
    const html = renderToStaticMarkup(
      <OutboundOperationLogPanel
        state={{ kind: "loaded", log: { items: [operation], completeness: { kind: "complete", total: 1 } }, summary }}
        page={1}
      />,
    );
    expect(html).toContain("Publication activity");
    expect(html).toContain("listing-a");
    expect(html).toContain("1000 ms");
    expect(html).toContain('data-channels-outbound-operation-log="true"');
  });

  it("renders the explicit empty and bounded-incomplete states", () => {
    const empty = renderToStaticMarkup(
      <OutboundOperationLogPanel
        state={{
          kind: "loaded",
          log: { items: [], completeness: { kind: "complete", total: 0 } },
          summary: { ...summary, completeness: { kind: "complete", total: 0 }, succeeded: 0 },
        }}
        page={1}
      />,
    );
    expect(empty).toContain("No publication activity");

    const incomplete = renderToStaticMarkup(
      <OutboundOperationLogPanel
        state={{
          kind: "loaded",
          log: { items: [operation], completeness: { kind: "bounded-incomplete", reason: "count-mismatch" } },
          summary: { ...summary, completeness: { kind: "bounded-incomplete", reason: "count-mismatch" } },
        }}
        page={1}
      />,
    );
    expect(incomplete).toContain("Activity is still being reconciled");
  });

  it("renders a read-error banner without a partial table", () => {
    const html = renderToStaticMarkup(<OutboundOperationLogPanel state={{ kind: "read-error" }} page={1} />);
    expect(html).toContain("Publication activity is unavailable");
    expect(html).not.toContain("<table");
  });
});
