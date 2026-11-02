import { describe, expect, it } from "vitest";
import {
  identityAccountProfileReportReasons,
  parseIdentityAccountProfileReportSubmittedPayload,
  parseMarketplaceReportSubmittedPayload,
  parsePlatformOperationsReportedContentActionRecordedPayload,
  platformOperationsReportedContentActionsByTargetType,
  platformOperationsReportedContentActionsRequiringNote,
} from "./public-event-payloads";

const reporter = "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const target = "acc_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const accountProfileReport = Object.freeze({
  version: 1,
  reportId: "rpt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  targetType: "account-profile",
  targetId: target,
  reporterAccountId: reporter,
  reason: "impersonation-or-deception",
  details: "Uses another seller's shop name.",
  submittedAt: "2026-10-21T02:29:00.000Z",
});
const actionRecorded = Object.freeze({
  actionId: "rca_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  targetType: "listing",
  targetId: "lst_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  action: "dismiss",
  note: null,
  operatorUserId: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  recordedAt: "2026-10-21T02:30:00.000Z",
});
const marketplaceReport = Object.freeze({
  reportId: "rpt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  targetType: "listing",
  targetId: "lst_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  targetOwnerAccountId: target,
  reporterKind: "visitor",
  reporterKey: "visitor:anon_1",
  reporterAccountId: null,
  reporterUserId: null,
  reason: "counterfeit-concern",
  details: null,
  sourceRoutePath: "/listings/lst_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  submittedAt: "2026-10-21T02:28:00.000Z",
});

function withPrototypeKey(value: object) {
  return JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(value).slice(1)}`) as unknown;
}

describe("reported-content public contracts", () => {
  it("Account Profile Report v1 accepts every reason and returns the closed record", () => {
    for (const reason of identityAccountProfileReportReasons) {
      expect(parseIdentityAccountProfileReportSubmittedPayload({ ...accountProfileReport, reason })).toEqual({
        ...accountProfileReport,
        reason,
      });
    }
    expect(parseIdentityAccountProfileReportSubmittedPayload({ ...accountProfileReport, details: null }).details).toBe(
      null,
    );
    expect(
      parseIdentityAccountProfileReportSubmittedPayload({
        ...accountProfileReport,
        details: "x".repeat(1000),
        submittedAt: "2026-10-21T02:29:00+05:30",
      }).details,
    ).toHaveLength(1000);
  });

  it.each([
    ["nested-unknown", { ...accountProfileReport, details: { text: "nested" } }],
    ["unknown field", { ...accountProfileReport, route: "/accounts/x" }],
    ["user identity field", { ...accountProfileReport, reporterUserId: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    ["missing field", (({ details: _details, ...rest }) => rest)(accountProfileReport)],
    ["prototype key", withPrototypeKey(accountProfileReport)],
    ["version", { ...accountProfileReport, version: 2 }],
    ["string version", { ...accountProfileReport, version: "1" }],
    ["target type", { ...accountProfileReport, targetType: "listing" }],
    ["reason", { ...accountProfileReport, reason: "counterfeit-concern" }],
    ["self-report", { ...accountProfileReport, reporterAccountId: target }],
    ["non-canonical target", { ...accountProfileReport, targetId: "acc_1" }],
    ["non-canonical report id", { ...accountProfileReport, reportId: "report_1" }],
    ["overlength", { ...accountProfileReport, details: "x".repeat(1001) }],
    ["untrimmed details", { ...accountProfileReport, details: " padded " }],
    ["blank details", { ...accountProfileReport, details: "" }],
    ["date-only", { ...accountProfileReport, submittedAt: "2026-10-21" }],
    ["zoneless", { ...accountProfileReport, submittedAt: "2026-10-21T02:29:00" }],
    ["calendar-invalid", { ...accountProfileReport, submittedAt: "2026-02-30T02:29:00Z" }],
    ["array", [accountProfileReport]],
    ["null", null],
  ])("Account Profile Report rejects %s", (_name, value) => {
    expect(() => parseIdentityAccountProfileReportSubmittedPayload(value)).toThrow(/^Account Profile Report /);
  });

  it("action audit accepts exactly each target's actions and requires a note where the contract does", () => {
    const accountTarget = { ...actionRecorded, targetType: "account-profile", targetId: target };
    for (const [targetType, actions] of Object.entries(platformOperationsReportedContentActionsByTargetType)) {
      const base = targetType === "account-profile" ? accountTarget : { ...actionRecorded, targetType };
      for (const action of actions) {
        const value = { ...base, action, note: "Operator reason" };
        expect(parsePlatformOperationsReportedContentActionRecordedPayload(value)).toEqual(value);
        const requiresNote = (platformOperationsReportedContentActionsRequiringNote as readonly string[]).includes(
          action,
        );
        for (const note of [null, "   "]) {
          const parse = () => parsePlatformOperationsReportedContentActionRecordedPayload({ ...value, note });
          if (requiresNote) expect(parse).toThrow("requires a note");
          else expect(parse()).toEqual({ ...value, note });
        }
      }
    }
    expect(Object.keys(platformOperationsReportedContentActionsByTargetType)).toEqual([
      "listing",
      "review",
      "account-profile",
    ]);
  });

  it.each([
    ["nested-unknown", { ...actionRecorded, note: { text: "nested" } }],
    ["unknown field", { ...actionRecorded, reporterAccountId: reporter }],
    ["missing field", (({ note: _note, ...rest }) => rest)(actionRecorded)],
    ["prototype key", withPrototypeKey(actionRecorded)],
    ["unknown target", { ...actionRecorded, targetType: "saved-list" }],
    ["unknown action", { ...actionRecorded, action: "reopen" }],
    ["cross-target action", { ...actionRecorded, action: "withdraw-review", note: "x" }],
    ["account action on listing", { ...actionRecorded, action: "contact-account" }],
    [
      "listing action on account",
      { ...actionRecorded, targetType: "account-profile", targetId: target, action: "unlist" },
    ],
    ["non-account profile target", { ...actionRecorded, targetType: "account-profile", action: "dismiss" }],
    ["non-canonical action id", { ...actionRecorded, actionId: "action_1" }],
    ["blank target id", { ...actionRecorded, targetId: "" }],
    ["blank operator", { ...actionRecorded, operatorUserId: "" }],
    ["date-only", { ...actionRecorded, recordedAt: "2026-10-21" }],
  ])("action audit rejects %s", (_name, value) => {
    expect(() => parsePlatformOperationsReportedContentActionRecordedPayload(value)).toThrow(/^Reported Content /);
  });

  it("historical action audits and Marketplace Reports parse unchanged", () => {
    for (const value of [
      actionRecorded,
      { ...actionRecorded, targetId: "lst_1", operatorUserId: null, note: "Keep provenance" },
      { ...actionRecorded, targetType: "review", targetId: "rev_1", action: "withdraw-review", note: "Abusive." },
    ]) {
      expect(parsePlatformOperationsReportedContentActionRecordedPayload(value)).toStrictEqual(value);
    }
    for (const value of [
      marketplaceReport,
      {
        ...marketplaceReport,
        targetType: "review",
        targetId: "rev_1",
        reporterKind: "account",
        reporterKey: "account:acc_buyer",
        reporterAccountId: "acc_buyer",
        reporterUserId: "usr_buyer",
        reason: "retired-marketplace-reason",
        details: "Wrong photo.",
      },
    ]) {
      expect(parseMarketplaceReportSubmittedPayload(value)).toStrictEqual(value);
    }
  });

  it.each([
    ["unknown field", { ...marketplaceReport, extra: true }],
    ["missing field", (({ sourceRoutePath: _path, ...rest }) => rest)(marketplaceReport)],
    ["prototype key", withPrototypeKey(marketplaceReport)],
    ["unknown target", { ...marketplaceReport, targetType: "account-profile" }],
    ["unknown reporter kind", { ...marketplaceReport, reporterKind: "operator" }],
    ["nested-unknown", { ...marketplaceReport, details: { text: "nested" } }],
    ["blank reason", { ...marketplaceReport, reason: "" }],
    ["date-only", { ...marketplaceReport, submittedAt: "2026-10-21" }],
  ])("Marketplace Report rejects %s", (_name, value) => {
    expect(() => parseMarketplaceReportSubmittedPayload(value)).toThrow(/^Marketplace Report /);
  });
});
