import { describe, expect, it, vi } from "vitest";
import { runCountCaptureRequest } from "../../../scope-sync-batches/api/count-capture-context";
import { sendCatalogProviderRequest } from "./provider-send-admission";
import { acquireScrydexPageOneCount, scrydexCountQuery } from "./scrydex/adapter";

describe("caps actual sends", () => {
  it.each(["cards", "sealed"] as const)("classifies %s acquisition without an unrelated send window", async (kind) => {
    const f = fixture();
    f.transport.mockResolvedValue(Response.json({ data: [], total_count: 0, page_size: 100, page: 1 }));
    const query = scrydexCountQuery({
      environment: "staging",
      accountRevision: "synthetic",
      productDomain: "one-piece",
      profileKey: `synthetic-${kind}`,
      profileVersion: "synthetic",
      unitKey: `scrydex:one-piece:${kind === "cards" ? "single-card" : "sealed-product"}:source-observation-import`,
      kind,
      languageCode: "en",
      parentValue: "OP01",
    });
    await f.run(() =>
      acquireScrydexPageOneCount(query, {
        fetch: f.transport,
        credentials: { apiKey: "synthetic", teamId: "synthetic" },
      }),
    );
    expect(f.ledger.debit).toHaveBeenCalledWith(expect.anything(), {
      category: kind,
      requestFingerprint: query.requestFingerprint,
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  function fixture(limit = 4) {
    let debits = 0;
    const ledger = {
      debit: vi.fn(async () => {
        if (++debits > limit) throw new Error("capture-stopped");
        return debits;
      }),
      result: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const transport = vi.fn<typeof fetch>(async () => new Response("{}"));
    const binding = { runId: "synthetic-run", requestId: "synthetic-request", phase: "preview" as const };
    const run = <T>(work: () => Promise<T>) => runCountCaptureRequest({ binding, ledger }, work);
    const send = (url = "https://api.scrydex.com/account/v1/usage", category = "usage" as const) =>
      sendCatalogProviderRequest("scrydex", transport, url, undefined, category);
    return { ledger, transport, run, send };
  }

  it("debits before transport, caps concurrent sends, and does not borrow phase slots", async () => {
    const f = fixture();
    f.transport.mockImplementation(async (_url, init) => {
      expect(f.ledger.debit).toHaveBeenCalled();
      expect(init?.redirect).toBe("manual");
      return new Response("{}");
    });
    const results = await f.run(() => Promise.allSettled(Array.from({ length: 5 }, () => f.send())));
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
    expect(f.transport).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["https://api.scrydex.com/account/v1/usage?extra=1", "usage"],
    ["https://attacker.invalid/account/v1/usage", "usage"],
    ["https://api.scrydex.com/onepiece/v1/expansions", "discovery"],
  ] as const)("refuses unclassified destination/category %s before transport", async (url, category) => {
    const f = fixture();
    await expect(
      f.run(() => sendCatalogProviderRequest("scrydex", f.transport, url, undefined, category)),
    ).rejects.toThrow("capture-stopped");
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("refuses non-Scrydex, unknown category, redirects, errors and failed result commits", async () => {
    for (const mode of ["non-scrydex", "unknown", "redirect", "timeout", "commit"] as const) {
      const f = fixture();
      if (mode === "redirect") f.transport.mockResolvedValue(new Response(null, { status: 302 }));
      if (mode === "timeout") f.transport.mockRejectedValue(new Error("synthetic timeout"));
      if (mode === "commit") f.ledger.result.mockRejectedValue(new Error("synthetic commit failure"));
      await expect(
        f.run(() =>
          sendCatalogProviderRequest(
            mode === "non-scrydex" ? "tcgdex" : "scrydex",
            f.transport,
            "https://api.scrydex.com/account/v1/usage",
            undefined,
            mode === "unknown" ? undefined : "usage",
          ),
        ),
      ).rejects.toThrow("capture-stopped");
      expect(f.ledger.stop).toHaveBeenCalled();
      expect(f.transport).toHaveBeenCalledTimes(["non-scrydex", "unknown"].includes(mode) ? 0 : 1);
    }
  });

  it("rejects zero admitted slots and requests redirects manually", async () => {
    const f = fixture(0);
    await expect(f.run(() => f.send())).rejects.toThrow("capture-stopped");
    expect(f.transport).not.toHaveBeenCalled();
    const redirect = fixture();
    redirect.transport.mockImplementation(async (_url, init) => {
      if (init?.redirect !== "manual") throw new Error("no-redirect-deleted mutant survived");
      return new Response(null, { status: 307 });
    });
    await expect(redirect.run(() => redirect.send())).rejects.toThrow("capture-stopped");
    expect(redirect.ledger.result).not.toHaveBeenCalled();
  });

  it("leaves unbound provider callers unchanged", async () => {
    const f = fixture();
    await f.send();
    expect(f.ledger.debit).not.toHaveBeenCalled();
    expect(f.transport).toHaveBeenCalledWith("https://api.scrydex.com/account/v1/usage", undefined);
  });
});
