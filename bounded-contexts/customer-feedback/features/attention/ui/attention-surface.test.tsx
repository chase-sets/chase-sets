// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatDateTime, t } from "@chase-sets/localization";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listFeedbackAttention, type FeedbackAttentionQueueItem } from "../read-model/queries";
import { FeedbackAttentionSurface, type FeedbackAttentionMetrics } from "./attention-surface";

const readNow = "2026-07-14T12:00:00.250Z";

const metrics: FeedbackAttentionMetrics = {
  activeCount: 7,
  overdueCount: 4,
  medianTimeToTriageMs: 1_800_000,
  medianTimeToCloseMs: null,
  oldestOverdueMs: 7_200_000,
  deliverySuccesses: 2,
  deliveryFailures: 1,
  digestPending: 0,
  digestFailures: 0,
  latestDigestAt: null,
};

function attentionRow(attentionId: string, fields: Readonly<Record<string, unknown>>) {
  return {
    attentionId,
    caseId: `fbcase_${attentionId}`,
    state: "active",
    reason: "low-score",
    ruleVersion: "low-score-v1",
    rating: 1,
    priority: "urgent",
    ownerId: null,
    triagedAt: null,
    dueAt: null,
    closedAt: null,
    deliveryStatus: "pending",
    deliveryReference: null,
    deliveryReportedAt: null,
    followUpDeliveryStatus: "not-requested",
    followUpChannel: null,
    ...fields,
  };
}

const at = (iso: string) => new Date(iso);

const lifecycleRows = [
  attentionRow("untriaged-past-triage", {
    openedAt: at("2026-07-14T10:00:00.250Z"),
    triageDueAt: at("2026-07-14T11:00:00.250Z"),
  }),
  attentionRow("triaged-past-due", {
    priority: "normal",
    openedAt: at("2026-07-14T08:00:00.250Z"),
    triagedAt: at("2026-07-14T08:30:00.250Z"),
    dueAt: at("2026-07-14T11:00:00.250Z"),
    triageDueAt: at("2026-07-15T08:00:00.250Z"),
  }),
  attentionRow("closed", {
    openedAt: at("2026-07-14T10:00:00.250Z"),
    triageDueAt: at("2026-07-14T11:00:00.250Z"),
    closedAt: at("2026-07-14T11:30:00.250Z"),
  }),
  attentionRow("within-both-deadlines", {
    priority: "high",
    ownerId: "usr_owner",
    openedAt: at("2026-07-14T11:00:00.250Z"),
    dueAt: at("2026-07-15T12:00:00.250Z"),
    triageDueAt: at("2026-07-14T15:00:00.250Z"),
  }),
  attentionRow("fallback-untriaged", {
    priority: "low",
    openedAt: at("2026-07-14T11:00:00.250Z"),
    triageDueAt: at("2026-07-16T11:00:00.250Z"),
  }),
  attentionRow("fallback-triaged", {
    priority: "normal",
    openedAt: at("2026-07-14T11:00:00.250Z"),
    triagedAt: at("2026-07-14T11:10:00.250Z"),
    triageDueAt: at("2026-07-15T11:00:00.250Z"),
  }),
  attentionRow("triage-boundary-exact", {
    openedAt: at("2026-07-14T11:00:00.250Z"),
    triageDueAt: at("2026-07-14T12:00:00.250Z"),
  }),
  attentionRow("triage-boundary-plus-1ms", {
    openedAt: at("2026-07-14T11:00:00.249Z"),
    triageDueAt: at("2026-07-14T12:00:00.249Z"),
  }),
  attentionRow("due-boundary-exact", {
    openedAt: at("2026-07-14T09:00:00.250Z"),
    triagedAt: at("2026-07-14T09:05:00.250Z"),
    dueAt: at("2026-07-14T12:00:00.250Z"),
    triageDueAt: at("2026-07-14T10:00:00.250Z"),
  }),
  attentionRow("due-boundary-plus-1ms", {
    openedAt: at("2026-07-14T09:00:00.250Z"),
    triagedAt: at("2026-07-14T09:05:00.250Z"),
    dueAt: at("2026-07-14T12:00:00.249Z"),
    triageDueAt: at("2026-07-14T10:00:00.250Z"),
  }),
  attentionRow("reprioritized", {
    openedAt: at("2026-07-14T09:00:00.250Z"),
    triageDueAt: at("2026-07-16T09:00:00.250Z"),
  }),
];

// The API serializes the read model's items; render exactly what the read returns.
async function apiItems(): Promise<readonly FeedbackAttentionQueueItem[]> {
  const items = await listFeedbackAttention({ query: vi.fn(async () => ({ rows: lifecycleRows })) } as never, {
    now: readNow,
  });
  return JSON.parse(JSON.stringify(items)) as FeedbackAttentionQueueItem[];
}

function tableRow(attentionId: string): HTMLElement {
  const link = within(screen.getByRole("table")).getByRole("link", { name: `fbcase_${attentionId}` });
  const row = link.closest("tr");
  if (!row) throw new Error(`missing table row for ${attentionId}`);
  return row;
}

function slaCell(attentionId: string): string {
  return within(tableRow(attentionId)).getAllByRole("cell")[3]?.textContent ?? "";
}

describe("FeedbackAttentionSurface", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("returns API-owned SLA state for the attention lifecycle and deadline boundaries", async () => {
    const items = await apiItems();
    // A browser clock far past every deadline must not change what the API decided.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    render(<FeedbackAttentionSurface items={items} metrics={metrics} />);

    const breached = t("customer-feedback.attention.sla.breached");
    expect(Object.fromEntries(items.map((item) => [item.attentionId, slaCell(item.attentionId)]))).toEqual({
      "untriaged-past-triage": breached,
      "triaged-past-due": breached,
      closed: formatDateTime("2026-07-14T11:00:00.250Z"),
      "within-both-deadlines": formatDateTime("2026-07-15T12:00:00.250Z"),
      "fallback-untriaged": formatDateTime("2026-07-16T11:00:00.250Z"),
      "fallback-triaged": formatDateTime("2026-07-15T11:00:00.250Z"),
      "triage-boundary-exact": formatDateTime("2026-07-14T12:00:00.250Z"),
      "triage-boundary-plus-1ms": breached,
      "due-boundary-exact": formatDateTime("2026-07-14T12:00:00.250Z"),
      "due-boundary-plus-1ms": breached,
      reprioritized: breached,
    });
    for (const item of items) {
      expect(slaCell(item.attentionId)).toBe(
        item.sla.overdue ? breached : formatDateTime(item.sla.effectiveDueAt ?? item.sla.triageDueAt),
      );
    }
  });

  it("keeps every non-SLA column, header, metric and row order unchanged", async () => {
    const items = await apiItems();
    render(<FeedbackAttentionSurface items={items} metrics={metrics} />);
    const table = screen.getByRole("table");

    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      t("customer-feedback.attention.case"),
      t("customer-feedback.attention.priority"),
      t("customer-feedback.attention.rating"),
      t("customer-feedback.attention.sla"),
      t("customer-feedback.attention.delivery"),
      t("customer-feedback.attention.owner"),
    ]);
    expect(
      within(table)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(lifecycleRows.map((row) => row.caseId));

    const owned = within(tableRow("within-both-deadlines")).getAllByRole("cell");
    expect(owned.map((cell) => cell.textContent)).toEqual([
      "fbcase_within-both-deadlines",
      "high",
      "1/5",
      formatDateTime("2026-07-15T12:00:00.250Z"),
      "pending / not-requested",
      "usr_owner",
    ]);
    expect(within(owned[0]!).getByRole("link").getAttribute("href")).toBe(
      "/support/customer-feedback/attention?caseId=fbcase_within-both-deadlines",
    );
    expect(within(tableRow("closed")).getAllByRole("cell")[5]?.textContent).toBe(
      t("customer-feedback.attention.unassigned"),
    );
    for (const label of [
      t("customer-feedback.attention.metrics.active"),
      t("customer-feedback.attention.metrics.overdue"),
      t("customer-feedback.attention.metrics.timeToTriage"),
      t("customer-feedback.attention.metrics.deliveryFailures"),
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("has no SLA helper import or call and no browser clock prop", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "attention-surface.tsx"), "utf8");

    expect(source).not.toMatch(/feedbackCaseSlaState|triageDueAt\(/);
    expect(source).not.toMatch(/\bnow\b/);
    expect(source).not.toMatch(/new Date\(|Date\.now\(/);
    expect(source).toContain("formatDateTime(sla.effectiveDueAt ?? sla.triageDueAt)");
  });
});
