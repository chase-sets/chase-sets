import { afterEach, describe, expect, it, vi } from "vitest";
import { action } from "./public-listing";

const attemptId = "visitor_report_attempt_0001";
const anonymousReportId = "anon_first_visit_binding";
function request(intent = "report-listing", cookie?: string, binding = anonymousReportId) {
  return new Request("http://localhost/listings/one", {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({
      intent,
      listingId: "lst_one",
      reason: "other",
      details: "Please check",
      attemptId,
      anonymousReportId: binding,
    }),
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("public Listing report recovery", () => {
  it("retains first-visit binding across possible-send loss and makes exactly one same-reporter replay", async () => {
    const sent: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (!req.url.includes("/report")) throw new Error(`Unexpected request: ${req.url}`);
        sent.push(req.clone());
        if (sent.length === 1) throw new TypeError("response lost");
        return new Response(JSON.stringify({ id: "rpt_first", version: 1, status: "submitted" }), { status: 201 });
      }),
    );
    const first = await action({ request: request(), params: { listingSlug: "one" }, context: undefined } as never);
    expect(first).toMatchObject({ attemptId, mutationPhase: "confirming" });
    expect(sent).toHaveLength(1);
    const replay = await action({
      request: request("confirm:report-listing"),
      params: { listingSlug: "one" },
      context: undefined,
    } as never);
    expect(replay).toBeInstanceOf(Response);
    expect((replay as Response).headers.get("set-cookie")).toContain(anonymousReportId);
    expect(sent).toHaveLength(2);
    expect(await sent[0]!.json()).toEqual(await sent[1]!.json());
    expect([...sent[0]!.headers]).toEqual([...sent[1]!.headers]);
    expect(JSON.stringify({ first, location: (replay as Response).headers.get("location") })).not.toContain(
      anonymousReportId,
    );
  });

  it("fails safely without sending when first-visit binding is absent", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await action({
        request: request("report-listing", undefined, ""),
        params: { listingSlug: "one" },
        context: undefined,
      } as never),
    ).toMatchObject({ mutationPhase: "failed-safe" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prefers the established reporter cookie over a changed hidden binding", async () => {
    const sent: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(input instanceof Request ? input : new Request(input, init));
        return new Response(JSON.stringify({ id: "rpt_first", version: 1 }), { status: 201 });
      }),
    );
    const result = await action({
      request: request("report-listing", "chase_sets_anonymous_reports=anon_established"),
      params: { listingSlug: "one" },
      context: undefined,
    } as never);
    expect((result as Response).headers.get("set-cookie")).toContain("anon_established");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify([...sent[0]!.headers])).toContain("anon_established");
    expect(JSON.stringify([...sent[0]!.headers])).not.toContain(anonymousReportId);
  });
});

function answer(status: number, code: string, message: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: { code, message } }), { status })),
  );
}

async function report(intent?: string) {
  return (await action({
    request: request(intent),
    params: { listingSlug: "one" },
    context: undefined,
  } as never)) as { data: Record<string, unknown>; init: { status: number } | null };
}

describe("public Listing report refusals", () => {
  it("answers a repeat report with 409 and says it was already reported", async () => {
    answer(409, "report_already_submitted", "This reporter has already reported this content.");
    const result = await report();
    expect(result.init?.status).toBe(409);
    expect(result.data).toMatchObject({ attemptId, alreadyReported: true });
  });

  it("answers a confirm:report-listing duplicate replay as already reported, not failed-safe", async () => {
    const serverMessage = "This reporter has already reported this content.";
    answer(409, "report_already_submitted", serverMessage);
    const result = await report("confirm:report-listing");
    expect(result.init?.status).toBe(409);
    expect(result.data).toMatchObject({ attemptId, alreadyReported: true, mutationPhase: "succeeded" });
    expect(result.data).not.toHaveProperty("error");
    expect(JSON.stringify(result.data)).not.toContain(serverMessage);
  });

  it("answers a rate-limited report with 429, says to try again later and keeps the report", async () => {
    answer(429, "rate_limited", "Too many requests.");
    const result = await report();
    expect(result.init?.status).toBe(429);
    expect(result.data).toMatchObject({
      mutationPhase: "failed-safe",
      error: "You have sent several reports in a short time. Try again in a few minutes.",
      values: { reason: "other", details: "Please check" },
    });
  });

  it("answers a refused report with the API's message and keeps the reason and details", async () => {
    answer(400, "validation_failed", "Sellers cannot report their own listings.");
    const result = await report();
    expect(result.init?.status).toBe(400);
    expect(result.data).toMatchObject({
      mutationPhase: "failed-safe",
      error: "Sellers cannot report their own listings.",
      values: { reason: "other", details: "Please check" },
    });
  });

  it("leaves an unexpected failure to the error page", async () => {
    answer(503, "unavailable", "Down for maintenance.");
    await expect(report()).rejects.toMatchObject({ status: 503 });
  });
});
