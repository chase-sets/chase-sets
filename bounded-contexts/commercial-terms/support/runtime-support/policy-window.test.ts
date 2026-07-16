import { describe, expect, it } from "vitest";
import { PlatformPolicyDomainError } from "@chase-sets/platform-policy/domain";
import {
  decideCommercialTermsPolicyWindow,
  evolveCommercialTermsPolicyWindow,
  initialCommercialTermsPolicyWindowState,
  type CommercialTermsPolicyWindowState,
  type RecordCommercialTermsPolicyWindowCommand,
} from "./policy-window";

/**
 * Guards `windowsOverlap` against the NaN-evasion hazard: `Date.parse` on a
 * malformed bound yields `NaN`, and every comparison against `NaN` is false,
 * so an unchecked NaN bound would make an overlapping window look
 * non-overlapping. The decider must fail closed (reject) instead of silently
 * admitting it.
 */

function recordCommand(
  overrides: Partial<RecordCommercialTermsPolicyWindowCommand> = {},
): RecordCommercialTermsPolicyWindowCommand {
  return {
    type: "RecordCommercialTermsPolicyWindow",
    documentId: "doc_new",
    status: "active",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
    overlapMessage: (overlapDocumentId) => `Active document ${overlapDocumentId} already covers that window.`,
    ...overrides,
  };
}

function stateWithExistingActiveDocument(
  overrides: Partial<CommercialTermsPolicyWindowState["documents"][string]> = {},
): CommercialTermsPolicyWindowState {
  return evolveCommercialTermsPolicyWindow(initialCommercialTermsPolicyWindowState, {
    type: "commercial-terms.policy-window.recorded",
    data: {
      documentId: "doc_existing",
      status: "active",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: "2026-12-31T00:00:00.000Z",
      ...overrides,
    },
  });
}

describe("decideCommercialTermsPolicyWindow - NaN-evasion hardening", () => {
  it("rejects a new window whose effectiveFrom is unparseable, rather than silently admitting it", () => {
    const state = stateWithExistingActiveDocument();
    const command = recordCommand({ effectiveFrom: "not-a-date", effectiveUntil: null });

    expect(() => decideCommercialTermsPolicyWindow(state, command)).toThrow(PlatformPolicyDomainError);
  });

  it("rejects a new window whose effectiveUntil is unparseable, rather than silently admitting it", () => {
    const state = stateWithExistingActiveDocument();
    const command = recordCommand({ effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "not-a-date" });

    expect(() => decideCommercialTermsPolicyWindow(state, command)).toThrow(PlatformPolicyDomainError);
  });

  it("rejects a new window when the existing recorded document it is compared against has an unparseable bound", () => {
    const state = stateWithExistingActiveDocument({ effectiveFrom: "garbage-timestamp" });
    const command = recordCommand({ effectiveFrom: "2026-06-01T00:00:00.000Z", effectiveUntil: null });

    expect(() => decideCommercialTermsPolicyWindow(state, command)).toThrow(PlatformPolicyDomainError);
  });

  it("does not fail closed for an inactive document with an unparseable bound, since inactive windows are never overlap-checked", () => {
    const state = stateWithExistingActiveDocument({ status: "inactive", effectiveFrom: "garbage-timestamp" });
    const command = recordCommand({ effectiveFrom: "2026-06-01T00:00:00.000Z", effectiveUntil: null });

    expect(() => decideCommercialTermsPolicyWindow(state, command)).not.toThrow();
  });
});

describe("decideCommercialTermsPolicyWindow - valid windows (regression)", () => {
  it("still detects a genuinely overlapping active window and rejects it", () => {
    const state = stateWithExistingActiveDocument({
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: "2026-12-31T00:00:00.000Z",
    });
    const command = recordCommand({ effectiveFrom: "2026-06-01T00:00:00.000Z", effectiveUntil: null });

    expect(() => decideCommercialTermsPolicyWindow(state, command)).toThrow(
      "Active document doc_existing already covers that window.",
    );
  });

  it("still admits a genuinely non-overlapping active window", () => {
    const state = stateWithExistingActiveDocument({
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: "2026-06-30T00:00:00.000Z",
    });
    const command = recordCommand({ effectiveFrom: "2026-07-01T00:00:00.000Z", effectiveUntil: null });

    const events = decideCommercialTermsPolicyWindow(state, command);

    expect(events).toEqual([
      {
        type: "commercial-terms.policy-window.recorded",
        data: {
          documentId: "doc_new",
          status: "active",
          effectiveFrom: "2026-07-01T00:00:00.000Z",
          effectiveUntil: null,
        },
      },
    ]);
  });

  it("admits a window for a document that is revising itself even though its prior window overlaps its own new window", () => {
    const state = stateWithExistingActiveDocument({
      documentId: "doc_new",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
    });
    const command = recordCommand({ effectiveFrom: "2026-03-01T00:00:00.000Z", effectiveUntil: null });

    expect(() => decideCommercialTermsPolicyWindow(state, command)).not.toThrow();
  });
});
