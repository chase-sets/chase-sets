import { afterEach, describe, expect, it, vi } from "vitest";
import { action } from "./public-listing";

const attemptId = "visitor_report_attempt_0001";
const anonymousReportId = "anon_first_visit_binding";
function request(intent = "report-listing", cookie?: string, binding = anonymousReportId) {
  return new Request("http://localhost/listings/one", {
    method: "POST", headers: { ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ intent, listingId: "lst_one", reason: "other", details: "Please check",
      attemptId, anonymousReportId: binding }),
  });
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("public Listing report recovery", () => {
  it("retains first-visit binding across possible-send loss and makes exactly one same-reporter replay", async () => {
    const sent: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (!req.url.includes("/report")) throw new Error(`Unexpected request: ${req.url}`);
      sent.push(req.clone());
      if (sent.length === 1) throw new TypeError("response lost");
      return new Response(JSON.stringify({ id: "rpt_first", version: 1, status: "submitted" }), { status: 201 });
    }));
    const first = await action({ request: request(), params: { listingSlug: "one" }, context: undefined } as never);
    expect(first).toMatchObject({ attemptId, mutationPhase: "confirming" });
    expect(sent).toHaveLength(1);
    const replay = await action({ request: request("confirm:report-listing"), params: { listingSlug: "one" }, context: undefined } as never);
    expect(replay).toBeInstanceOf(Response);
    expect((replay as Response).headers.get("set-cookie")).toContain(anonymousReportId);
    expect(sent).toHaveLength(2);
    expect(await sent[0]!.json()).toEqual(await sent[1]!.json());
    expect([...sent[0]!.headers]).toEqual([...sent[1]!.headers]);
    expect(JSON.stringify({ first, location: (replay as Response).headers.get("location") })).not.toContain(anonymousReportId);
  });

  it("fails safely without sending when first-visit binding is absent", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await action({ request: request("report-listing", undefined, ""), params: { listingSlug: "one" }, context: undefined } as never))
      .toMatchObject({ mutationPhase: "failed-safe" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prefers the established reporter cookie over a changed hidden binding", async () => {
    const sent: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(input instanceof Request ? input : new Request(input, init));
      return new Response(JSON.stringify({ id: "rpt_first", version: 1 }), { status: 201 });
    }));
    const result = await action({ request: request("report-listing", "chase_sets_anonymous_reports=anon_established"), params: { listingSlug: "one" }, context: undefined } as never);
    expect((result as Response).headers.get("set-cookie")).toContain("anon_established");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify([...sent[0]!.headers])).toContain("anon_established");
    expect(JSON.stringify([...sent[0]!.headers])).not.toContain(anonymousReportId);
  });
});
