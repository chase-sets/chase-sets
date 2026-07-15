import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OperationsAttentionQueuePage } from "./operations-attention-queue-page";
import {
  aggregateOperationsAttentionQueue,
  buildOperationsAttentionItem,
  type OperationsAttentionContext,
  type OperationsAttentionQueue,
} from "../read-model/attention-queue";

const CONTEXT: OperationsAttentionContext = { now: "2026-07-14T12:00:00.000Z" };

async function fixtureQueue(): Promise<OperationsAttentionQueue> {
  return aggregateOperationsAttentionQueue(
    [
      {
        id: "support-request-deadline",
        load: async () => [
          buildOperationsAttentionItem({
            source: "support-request-deadline",
            entityId: "req-1",
            severity: "critical",
            summary: { code: "supportRequest", params: { reference: "CASE-1" } },
            observedAt: "2026-07-13T00:00:00.000Z",
            dueAt: "2026-07-14T09:00:00.000Z",
          }),
        ],
      },
      {
        id: "projection-poison-event",
        load: async () => [
          buildOperationsAttentionItem({
            source: "projection-poison-event",
            entityId: "evt-1",
            severity: "critical",
            summary: {
              code: "poisonEvent",
              params: { eventType: "order.placed", projectionKey: "ordering.orders", retryCount: 2 },
            },
            observedAt: "2026-07-14T06:00:00.000Z",
          }),
        ],
      },
      {
        id: "platform-feedback-unreviewed",
        load: async () => [
          buildOperationsAttentionItem({
            source: "platform-feedback-unreviewed",
            entityId: "fb-1",
            severity: "info",
            summary: { code: "feedbackUnreviewed", params: { topic: "checkout" } },
            observedAt: "2026-07-14T10:00:00.000Z",
          }),
        ],
      },
    ],
    CONTEXT,
  );
}

describe("OperationsAttentionQueuePage", () => {
  it("renders the queue severity-ordered with a one-click link for every row", async () => {
    const queue = await fixtureQueue();
    render(<OperationsAttentionQueuePage queue={queue} />);

    // Every item's copy renders (the DataTable renders a desktop and a mobile
    // view, so each appears at least once).
    expect(screen.getAllByText(/CASE-1/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/order\.placed/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Unreviewed checkout feedback/).length).toBeGreaterThan(0);

    // Dated critical (support) leads the undated critical (poison), info last —
    // the "Open" links preserve queue order and each reaches its fix in one click.
    const orderedHrefs = [
      ...new Set(screen.getAllByRole("link", { name: "Open" }).map((link) => link.getAttribute("href"))),
    ];
    expect(orderedHrefs).toEqual(["/requests?requestId=req-1", "/projections?tab=blocked", "/platform-feedback/fb-1"]);
  });

  it("renders the rollup stat grid", async () => {
    const queue = await fixtureQueue();
    render(<OperationsAttentionQueuePage queue={queue} />);
    expect(screen.getByText("Total")).toBeTruthy();
    // No warning items in the fixture, so "Warning" appears only as a stat label.
    expect(screen.getByText("Warning")).toBeTruthy();
  });

  it("surfaces a degraded banner naming each unavailable source", async () => {
    const queue = await aggregateOperationsAttentionQueue(
      [
        {
          id: "support-request-deadline",
          load: async () => {
            throw new Error("support read model unavailable");
          },
        },
      ],
      CONTEXT,
    );
    render(<OperationsAttentionQueuePage queue={queue} />);

    expect(screen.getByText("Some sources are unavailable")).toBeTruthy();
    expect(screen.getByText(/Support case unavailable: support read model unavailable/)).toBeTruthy();
  });

  it("renders the empty state when nothing needs the operator", async () => {
    const queue = await aggregateOperationsAttentionQueue([], CONTEXT);
    render(<OperationsAttentionQueuePage queue={queue} />);
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
  });
});
