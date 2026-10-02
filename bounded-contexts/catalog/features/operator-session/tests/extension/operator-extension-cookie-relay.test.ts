import { describe, expect, it } from "vitest";
import { fixture, syntheticCookie } from "./fixture";
import { operatorCookieName } from "../../domain/extension/protocol";

describe("operator-extension-cookie-relay", () => {
  it("is paired-only and retains the trailing rate reservation over worker eviction", async () => {
    const f = fixture();
    await f.background.resume();
    expect(f.adapters.readCookie).not.toHaveBeenCalled();
    await f.pair();
    for (let index = 0; index < 20; index++) {
      f.cookie({
        name: operatorCookieName,
        value: `${syntheticCookie}_${index}`,
        domain: ".tcgplayer.com",
        path: "/admin",
        storeId: "0",
      });
      await f.change();
    }
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await f.restart();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.advance(60_000);
    await f.background.alarm("staging");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(f.fetcher.mock.calls[1]![1]!.body)).value).toBe(`${syntheticCookie}_19`);
    expect(JSON.stringify([...f.data.values()])).not.toContain(syntheticCookie);
  });
  it("removal is status-only; alarm absence never clears custody", async () => {
    const f = fixture();
    await f.pair();
    await f.background.cookieChanged({
      removed: true,
      cookie: {
        name: operatorCookieName,
        value: "EVENT_VALUE_NEVER_READ",
        domain: ".tcgplayer.com",
        path: "/admin",
        storeId: "0",
      },
    });
    expect((await f.command({ action: "status", environment: "staging" }))?.cookiePresent).toBe(false);
    f.cookie(null);
    f.advance(1_800_000);
    await f.background.resume();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.record().lastOutcome).toBe("cookie-absent");
  });
  it.each([
    { domain: "evil-tcgplayer.com" },
    { domain: "store.tcgplayer.com.attacker.test" },
    { name: "other" },
    { storeId: "1" },
    { partitionKey: { topLevelSite: "https://store.tcgplayer.com" } },
  ])("ignores ineligible event %j", async (change) => {
    const f = fixture();
    await f.pair();
    f.advance(60_000);
    await f.background.cookieChanged({
      removed: false,
      cookie: {
        name: operatorCookieName,
        value: "EVENT_VALUE_NEVER_READ",
        domain: ".tcgplayer.com",
        path: "/",
        storeId: "0",
        ...change,
      },
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("permanent refusals never replay on startup/alarm; recovery uses fresh bytes", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(Response.json({ code: "invalid-session-value" }, { status: 422 }));
    await f.pair();
    expect(f.record().state).toBe("error");
    f.advance(1_800_000);
    await f.restart();
    await f.background.alarm("staging");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.fetcher.mockResolvedValue(Response.json({ outcome: "stored", revision: 2 }));
    await f.command({ action: "recover", environment: "staging" });
    expect(f.record().state).toBe("idle");
  });
  it("503 and 429 retain bounded retry deadlines across restart", async () => {
    for (const [status, code, delay] of [
      [503, "custody-unavailable", 300_000],
      [429, "rate-limited", 3_600_000],
    ] as const) {
      const f = fixture();
      f.fetcher.mockImplementation(async () =>
        Response.json({ code }, { status, headers: { "Retry-After": "99999" } }),
      );
      await f.pair();
      f.advance(delay - 1);
      await f.restart();
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      f.advance(1);
      await f.background.alarm("staging");
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    }
  });
});
