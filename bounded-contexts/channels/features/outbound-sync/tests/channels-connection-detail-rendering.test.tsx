import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OUTBOUND_OPERATION_LOG_TRAIL_LIMIT,
  readOutboundOperationLogPosition,
  resolveOutboundOperationLogNavigation,
  type OutboundOperationLogNavigation,
} from "../ui/operation-log-navigation";
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

const firstPage: OutboundOperationLogNavigation = { previous: null, next: null };

describe("channels-connection-detail operation log rendering", () => {
  it("renders populated metrics and rows through canonical operational components", () => {
    const html = renderToStaticMarkup(
      <OutboundOperationLogPanel
        state={{
          kind: "loaded",
          log: { items: [operation], completeness: { kind: "complete", total: 1 } },
          summary,
          navigation: firstPage,
        }}
      />,
    );
    expect(html).toContain("Publication activity");
    expect(html).toContain("listing-a");
    expect(html).toContain("1000 ms");
    expect(html).toContain('data-channels-outbound-operation-log="true"');
    expect(html).not.toContain('data-channels-outbound-operation-log-navigation="true"');
  });

  it("renders the explicit empty and bounded-incomplete states", () => {
    const empty = renderToStaticMarkup(
      <OutboundOperationLogPanel
        state={{
          kind: "loaded",
          log: { items: [], completeness: { kind: "complete", total: 0 } },
          summary: { ...summary, completeness: { kind: "complete", total: 0 }, succeeded: 0 },
          navigation: firstPage,
        }}
      />,
    );
    expect(empty).toContain("No publication activity");

    const incomplete = renderToStaticMarkup(
      <OutboundOperationLogPanel
        state={{
          kind: "loaded",
          log: { items: [operation], completeness: { kind: "bounded-incomplete", reason: "count-mismatch" } },
          summary: { ...summary, completeness: { kind: "bounded-incomplete", reason: "count-mismatch" } },
          navigation: firstPage,
        }}
      />,
    );
    expect(incomplete).toContain("Activity is still being reconciled");
  });

  it("renders a read-error banner without a partial table", () => {
    const html = renderToStaticMarkup(<OutboundOperationLogPanel state={{ kind: "read-error" }} />);
    expect(html).toContain("Publication activity is unavailable");
    expect(html).not.toContain("<table");
  });

  it("offers only the reachable next page for a large reported total instead of numbered page jumps", () => {
    const navigation = resolveOutboundOperationLogNavigation({ cursor: null, trail: [] }, "cursor-page-2");
    const html = renderToStaticMarkup(
      <OutboundOperationLogPanel
        state={{
          kind: "loaded",
          log: { items: [operation], completeness: { kind: "complete", total: 500 }, nextCursor: "cursor-page-2" },
          summary: { ...summary, completeness: { kind: "complete", total: 500 }, succeeded: 500 },
          navigation,
        }}
      />,
    );
    expect(navigation).toEqual({ previous: null, next: { href: "?cursor=cursor-page-2&trail=" } });
    expect(html).toContain('data-channels-outbound-operation-log-navigation="true"');
    expect(html).toContain("Next activity page");
    expect(html).not.toContain("Previous activity page");
    expect(html).not.toContain('aria-label="Pagination"');
    expect(html).not.toContain('aria-current="page"');
    expect(html.match(/href="[^"]*"/g)).toEqual(['href="?cursor=cursor-page-2&amp;trail="']);
    expect(html.match(/rel="[^"]*"/g)).toEqual(['rel="next"']);
  });

  it("keeps enough cursor history for the third page to step back to exactly the second page", () => {
    const secondPage = resolveOutboundOperationLogNavigation({ cursor: null, trail: [] }, "cursor-page-2").next!;
    const secondPosition = readOutboundOperationLogPosition(new URLSearchParams(secondPage.href));
    expect(secondPosition).toEqual({ cursor: "cursor-page-2", trail: [""] });
    const fromSecond = resolveOutboundOperationLogNavigation(secondPosition, "cursor-page-3");
    expect(fromSecond.previous).toEqual({ href: "?", kind: "previous" });

    const thirdPosition = readOutboundOperationLogPosition(new URLSearchParams(fromSecond.next!.href));
    expect(thirdPosition).toEqual({ cursor: "cursor-page-3", trail: ["", "cursor-page-2"] });
    const fromThird = resolveOutboundOperationLogNavigation(thirdPosition, "cursor-page-4");
    expect(fromThird.previous).toEqual({ href: secondPage.href, kind: "previous" });
    expect(fromThird.next).toEqual({ href: "?cursor=cursor-page-4&trail=&trail=cursor-page-2&trail=cursor-page-3" });

    const html = renderToStaticMarkup(
      <OutboundOperationLogPanel
        state={{
          kind: "loaded",
          log: { items: [operation], completeness: { kind: "complete", total: 500 }, nextCursor: "cursor-page-4" },
          summary: { ...summary, completeness: { kind: "complete", total: 500 }, succeeded: 500 },
          navigation: fromThird,
        }}
      />,
    );
    expect(html).toContain("Previous activity page");
    expect(html).toContain("Next activity page");
    expect(html.match(/href="[^"]*"/g)).toEqual([
      'href="?cursor=cursor-page-2&amp;trail="',
      'href="?cursor=cursor-page-4&amp;trail=&amp;trail=cursor-page-2&amp;trail=cursor-page-3"',
    ]);
    expect(html.match(/rel="[^"]*"/g)).toEqual(['rel="prev"', 'rel="next"']);
  });

  it("offers the first page rather than inventing history for a cursor without a trail", () => {
    const position = readOutboundOperationLogPosition(new URLSearchParams("?cursor=cursor-page-7"));
    expect(position).toEqual({ cursor: "cursor-page-7", trail: [] });
    const navigation = resolveOutboundOperationLogNavigation(position, null);
    expect(navigation).toEqual({ previous: { href: "?", kind: "first" }, next: null });

    const html = renderToStaticMarkup(
      <OutboundOperationLogPanel
        state={{
          kind: "loaded",
          log: { items: [operation], completeness: { kind: "complete", total: 301 } },
          summary: { ...summary, completeness: { kind: "complete", total: 301 }, succeeded: 301 },
          navigation,
        }}
      />,
    );
    expect(html).toContain("First activity page");
    expect(html).not.toContain("Previous activity page");
    expect(html).not.toContain("Next activity page");
    expect(html.match(/href="[^"]*"/g)).toEqual(['href="?"']);
    expect(html.match(/rel="[^"]*"/g)).toBeNull();
  });

  it("ignores malformed cursors and bounds the retained trail without fabricating cursors", () => {
    expect(readOutboundOperationLogPosition(new URLSearchParams("?cursor=not%20a%20cursor&trail=a"))).toEqual({
      cursor: null,
      trail: [],
    });
    expect(readOutboundOperationLogPosition(new URLSearchParams("?trail=cursor-page-2"))).toEqual({
      cursor: null,
      trail: [],
    });

    const walked = Array.from({ length: OUTBOUND_OPERATION_LOG_TRAIL_LIMIT + 2 }, (_, index) => `cursor-${index}`);
    const deep = resolveOutboundOperationLogNavigation({ cursor: "cursor-current", trail: walked }, "cursor-next");
    const nextTrail = new URLSearchParams(deep.next!.href).getAll("trail");
    expect(nextTrail).toHaveLength(OUTBOUND_OPERATION_LOG_TRAIL_LIMIT);
    expect(nextTrail).toEqual([...walked.slice(-(OUTBOUND_OPERATION_LOG_TRAIL_LIMIT - 1)), "cursor-current"]);
    const previousQuery = new URLSearchParams(deep.previous!.href);
    expect(deep.previous!.kind).toBe("previous");
    expect(previousQuery.get("cursor")).toBe(walked.at(-1));
    expect(previousQuery.getAll("trail")).toEqual(walked.slice(0, -1));
  });
});
