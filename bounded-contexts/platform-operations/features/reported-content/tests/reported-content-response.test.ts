import { describe, expect, it, vi } from "vitest";
import {
  reportedContentDueTimes,
  reportedContentReason,
  reportedContentSeverity,
  isReportedContentBusinessDay,
  REPORTED_CONTENT_RESPONSE_POLICY,
} from "../read-model/response-policy";
import { deriveReportedContentResponse, type ResponseRow } from "../read-model/response-state";
import { createReportedContentRuntime } from "../api/runtime";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

describe("reported-content-severity-matrix", () => {
  it.each([
    ["counterfeit-concern", "counterfeit-ip-stolen-photo", "standard"],
    ["stolen-photos", "counterfeit-ip-stolen-photo", "standard"],
    ["prohibited-item", "prohibited-goods", "standard"],
    ["pricing-scam", "spam-manipulation", "standard"],
    ["spam-or-manipulation", "spam-manipulation", "standard"],
    ["harassment-or-abuse", "harassment-hate-threats", "high"],
    ["hate-or-discrimination", "harassment-hate-threats", "high"],
    ["sexual-exploitation", "sexual-exploitation", "critical"],
    ["personal-information", "exposed-personal-information", "critical"],
    ["impersonation-or-deception", "impersonation-deception", "high"],
    ["other", "other", "standard"],
    ["unknown", "policy-incomplete", "critical"],
    ["__proto__", "policy-incomplete", "critical"],
  ])("%s", (reason, category, severity) => expect(reportedContentReason(reason)).toEqual({ category, severity }));
  it("takes the maximum and raises repeat owners without creating any enforcement events", () => {
    expect(reportedContentSeverity(["other"], 1)).toBe("standard");
    expect(reportedContentSeverity(["other"], 2)).toBe("high");
    expect(reportedContentSeverity(["other", "sexual-exploitation"], 2)).toBe("critical");
    const response = deriveReportedContentResponse({ ...row(), prior_dispositions: 2 });
    expect(response.severity).toBe("high");
    expect(Object.keys(response)).not.toContain("events");
  });
});

describe("reported-content-due-time-matrix", () => {
  it.each([
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
    "2026-10-12",
    "2026-11-11",
    "2026-11-26",
    "2026-12-25",
  ])("excludes federal holiday %s", (date) => {
    expect(isReportedContentBusinessDay(new Date(`${date}T00:00:00.000Z`))).toBe(false);
  });
  it.each([
    ["2026-03-06T22:00:00.000Z", "2026-03-06T23:00:00.000Z", "2026-03-09T17:00:00.000Z"],
    ["2026-10-30T21:00:00.000Z", "2026-10-30T22:00:00.000Z", "2026-11-02T18:00:00.000Z"],
    ["2026-11-16T14:59:59.999Z", "2026-11-16T16:00:00.000Z", "2026-11-16T19:00:00.000Z"],
    ["2026-11-16T15:00:00.000Z", "2026-11-16T16:00:00.000Z", "2026-11-16T19:00:00.000Z"],
    ["2026-11-16T15:00:00.001Z", "2026-11-16T16:00:00.001Z", "2026-11-16T19:00:00.001Z"],
    ["2026-11-16T22:59:59.999Z", "2026-11-17T15:59:59.999Z", "2026-11-17T18:59:59.999Z"],
    ["2026-11-16T23:00:00.000Z", "2026-11-17T16:00:00.000Z", "2026-11-17T19:00:00.000Z"],
    ["2026-11-16T23:00:00.001Z", "2026-11-17T16:00:00.000Z", "2026-11-17T19:00:00.000Z"],
    ["2026-11-21T16:00:00.000Z", "2026-11-23T16:00:00.000Z", "2026-11-23T19:00:00.000Z"],
    ["2026-11-26T15:00:00.000Z", "2026-11-27T16:00:00.000Z", "2026-11-27T19:00:00.000Z"],
    ["2027-12-31T15:00:00.000Z", "2028-01-03T16:00:00.000Z", "2028-01-03T19:00:00.000Z"],
  ])("critical %s", (start, ack, disposition) => {
    for (const timeZone of ["UTC", "Asia/Tokyo"]) {
      vi.stubEnv("TZ", timeZone);
      expect(reportedContentDueTimes(start, "critical")).toMatchObject({
        acknowledge_due_at: ack,
        disposition_due_at: disposition,
      });
    }
    vi.unstubAllEnvs();
  });
  it("high disposition is a local calendar day even across DST and outside coverage", () => {
    expect(reportedContentDueTimes("2026-03-07T16:00:00.000Z", "high").disposition_due_at).toBe(
      "2026-03-08T15:00:00.000Z",
    );
    expect(reportedContentDueTimes("2026-10-31T15:00:00.000Z", "high").disposition_due_at).toBe(
      "2026-11-01T16:00:00.000Z",
    );
    expect(reportedContentDueTimes("2026-03-07T08:30:00.000Z", "high")).toMatchObject({
      severity: "critical",
      policy_code: "policy-incomplete",
      disposition_due_at: null,
    });
  });
  it("standard uses eight staffed hours per business day", () => {
    expect(reportedContentDueTimes("2026-11-25T19:00:00.000Z", "standard")).toMatchObject({
      acknowledge_due_at: "2026-11-27T19:00:00.000Z",
      disposition_due_at: "2026-12-01T19:00:00.000Z",
    });
  });
  it("fails closed when time or effective policy is missing", () => {
    expect(reportedContentDueTimes("invalid", "standard")).toMatchObject({
      severity: "critical",
      policy_code: "policy-incomplete",
    });
    expect(
      reportedContentDueTimes("2026-01-01", "standard", [] as unknown as typeof REPORTED_CONTENT_RESPONSE_POLICY),
    ).toMatchObject({ severity: "critical", policy_code: "policy-incomplete" });
    const partial = { ...REPORTED_CONTENT_RESPONSE_POLICY[0]!, targets: { standard: [1, 3] } };
    expect(
      reportedContentDueTimes("2026-11-16T15:00:00Z", "standard", [
        partial,
      ] as unknown as typeof REPORTED_CONTENT_RESPONSE_POLICY),
    ).toMatchObject({ severity: "critical", policy_code: "policy-incomplete" });
  });
  it("selects the revision effective at the start, not a future revision", () => {
    const first = REPORTED_CONTENT_RESPONSE_POLICY[0]!;
    const future = {
      ...first,
      revision: "future",
      effectiveAt: "2027-01-01T00:00:00.000Z",
      targets: { ...first.targets, critical: [2, 4] as const },
    };
    expect(reportedContentDueTimes("2026-11-16T15:00:00Z", "critical", [first, future]).policy_revision).toBe(
      first.revision,
    );
    expect(reportedContentDueTimes("2027-01-04T15:00:00Z", "critical", [first, future])).toMatchObject({
      policy_revision: "future",
      acknowledge_due_at: "2027-01-04T17:00:00.000Z",
    });
  });
});

function row(): ResponseRow {
  return {
    target_type: "listing",
    target_id: "lst_1",
    target_owner_account_id: "acc_1",
    status: "needs-review",
    reports: [{ reason: "other", submittedAt: "2026-11-16T15:00:00.000Z" }],
    last_action: null,
    last_action_at: null,
    auto_unlisted_at: null,
    response_actions: [],
    response_acknowledgements: [],
    response_version: 0,
    prior_dispositions: 0,
  };
}

describe("reported-content-acknowledgement-lifecycle", () => {
  it("stops one clock on acknowledgement and both on disposition; re-report starts a new cycle", () => {
    const initial = row();
    const ack = {
      startedAt: initial.reports[0]!.submittedAt,
      acknowledgedAt: "2026-11-16T16:00:00.000Z",
      operatorUserId: "usr_1",
    };
    expect(deriveReportedContentResponse({ ...initial, response_acknowledgements: [ack] })).toMatchObject({
      acknowledge_due_at: null,
      response_open: true,
    });
    const disposed = {
      ...initial,
      status: "dismissed" as const,
      last_action: "dismiss",
      last_action_at: "2026-11-16T17:00:00.000Z",
      response_acknowledgements: [ack],
    };
    expect(deriveReportedContentResponse(disposed)).toMatchObject({
      response_open: false,
      acknowledge_due_at: null,
      disposition_due_at: null,
    });
    const reopened = {
      ...disposed,
      reports: [...disposed.reports, { reason: "other", submittedAt: "2026-11-17T15:00:00.000Z" }],
    };
    expect(deriveReportedContentResponse(reopened)).toMatchObject({
      response_open: true,
      status: "needs-review",
      acknowledged_at: null,
      response_started_at: "2026-11-17T15:00:00.000Z",
    });
    expect(
      deriveReportedContentResponse({ ...reopened, last_action: "unlist", status: "manually-unlisted" }),
    ).toMatchObject({ response_open: false });
  });
  it("appends one private event, repeats are no-ops, and a stale projection cannot acknowledge a disposed stream", async () => {
    const history: { eventType: string; payload: Record<string, unknown>; streamVersion: number }[] = [];
    const appendToStream = vi.fn(async ({ events }) => {
      history.push({ ...events[0], streamVersion: history.length + 1 });
      return [];
    });
    const services = createReportedContentRuntime({
      db: {
        query: vi.fn(async () => ({
          rows: [
            {
              ...row(),
              first_reported_at: row().reports[0]!.submittedAt,
              response_started_at: row().reports[0]!.submittedAt,
              response_open: true,
            },
          ],
        })),
      } as unknown as PgQueryable,
      eventStore: { readStream: vi.fn(async () => history), appendToStream } as unknown as EventStore,
    });
    const command = { targetType: "listing", targetId: "lst_1", operatorUserId: "usr_1" };
    const first = await services.acknowledge(command, {} as never);
    expect(await services.acknowledge(command, {} as never)).toEqual(first);
    expect(appendToStream).toHaveBeenCalledTimes(1);
    expect(history.map((event) => event.eventType)).toEqual(["platform-operations.reported-content.acknowledged"]);
    expect(appendToStream.mock.calls[0]![0].expectedVersion).toBe("no_stream");
    history.push({
      eventType: "platform-operations.reported-content.action-recorded",
      payload: { recordedAt: "2026-11-17T15:00:00.000Z" },
      streamVersion: 2,
    });
    await expect(services.acknowledge(command, {} as never)).rejects.toMatchObject({ code: "target-disposed" });
    expect(appendToStream).toHaveBeenCalledTimes(1);
  });
});
