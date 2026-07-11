import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPolicyConsoleRevision,
  loadPolicyConsoleDocument,
  loadPolicyConsoleOverview,
  loadPolicyConsoleRegistry,
  PolicyConsoleValidationError,
} from "./policy-console-client";

function testRequest(url = "http://localhost/platform/policy-console") {
  return new Request(url, { headers: { cookie: "session=abc" } });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("policy console request client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the registry from the policy-console API mount", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/api/platform/policy-console");
      return jsonResponse({ items: [], commercialTermsSchedulesHref: "/terms/schedules" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const registry = await loadPolicyConsoleRegistry(testRequest());
    expect(registry.commercialTermsSchedulesHref).toBe("/terms/schedules");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("loads a policy overview by policy key", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/api/platform/policy-console/settlement.clearance-window");
      return jsonResponse({
        policyKey: "settlement.clearance-window",
        contextName: "settlement",
        schemaSummary: "test",
        current: {
          source: "fallback",
          documentId: null,
          status: null,
          value: {},
          effectiveFrom: null,
          effectiveUntil: null,
        },
        upcoming: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const overview = await loadPolicyConsoleOverview(testRequest(), "settlement.clearance-window");
    expect(overview.policyKey).toBe("settlement.clearance-window");
  });

  it("loads a document with its history", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/documents/pol_1");
      return jsonResponse({
        document_id: "pol_1",
        policy_key: "settlement.clearance-window",
        context_name: "settlement",
        status: "active",
        history: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const document = await loadPolicyConsoleDocument(testRequest(), "settlement.clearance-window", "pol_1");
    expect(document.document_id).toBe("pol_1");
  });

  it("creates a revision and returns the command snapshot", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/revisions");
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "pol_1", version: 2, scheduled: false }, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPolicyConsoleRevision(testRequest(), "settlement.clearance-window", {
      value: { maxDays: 3 },
      status: "active",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
    });
    expect(result).toEqual({ id: "pol_1", version: 2, scheduled: false });
  });

  it("surfaces a 400 validation failure as PolicyConsoleValidationError", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: "validation_failed", message: "maxDays must be between 0 and 30." } }, 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createPolicyConsoleRevision(testRequest(), "settlement.clearance-window", {
        value: { maxDays: 999 },
        status: "active",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
      }),
    ).rejects.toBeInstanceOf(PolicyConsoleValidationError);
  });
});
