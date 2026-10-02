import { describe, expect, it, vi } from "vitest";
import { deferred, fixture, syntheticCookie } from "./fixture";
import { operatorCookieName, operatorEnvironments, type OperatorCookie } from "../../domain/extension/protocol";

describe("operator-extension-cookie-relay", () => {
  it.each([false, true])("refuses an older read after removal (restart=%s)", async (restart) => {
    const f = fixture();
    const captured = (await f.adapters.readCookie())!;
    const reached = deferred<void>();
    const read = deferred<OperatorCookie | null>();
    vi.mocked(f.adapters.readCookie).mockImplementationOnce(() => {
      reached.resolve();
      return read.promise;
    });
    const pairing = f.pair();
    await reached.promise;
    f.cookie(null);
    await f.background.cookieChanged({ removed: true, cookie: captured });
    expect(await f.command({ action: "status", environment: "staging" })).toMatchObject({
      cookiePresent: false,
      browserExpiresAt: null,
    });
    read.resolve({ ...captured, expirationDate: 1_800_000_000 });
    await pairing;
    expect(await f.command({ action: "status", environment: "staging" })).toMatchObject({
      cookiePresent: false,
      browserExpiresAt: null,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.record().lastRevision).toBe(0);
    if (restart) await f.restart();
    f.advance(59_999);
    await f.background.alarm("staging");
    expect(f.fetcher).not.toHaveBeenCalled();
    f.advance(1);
    await f.background.alarm("staging");
    expect(f.record().lastOutcome).toBe("cookie-absent");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([false, true])("keeps a set's trailing fresh read (restart=%s)", async (restart) => {
    const f = fixture();
    const captured = (await f.adapters.readCookie())!;
    const reached = deferred<void>();
    const read = deferred<OperatorCookie | null>();
    vi.mocked(f.adapters.readCookie).mockImplementationOnce(() => {
      reached.resolve();
      return read.promise;
    });
    const pairing = f.pair();
    await reached.promise;
    const fresh = { ...captured, value: `${syntheticCookie}_FRESH`, expirationDate: 1_800_000_000 };
    f.cookie(fresh);
    const change = f.background.cookieChanged({
      removed: false,
      cookie: { ...fresh, value: "EVENT_VALUE_NEVER_READ" },
    });
    await f.command({ action: "status", environment: "staging" });
    read.resolve(captured);
    await Promise.all([pairing, change]);
    expect(f.record().dirty).toBe(true);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(await f.command({ action: "status", environment: "staging" })).toMatchObject({
      cookiePresent: false,
      browserExpiresAt: null,
    });
    if (restart) await f.restart();
    f.advance(59_999);
    await f.background.alarm("staging");
    expect(f.fetcher).not.toHaveBeenCalled();
    f.advance(1);
    await f.background.alarm("staging");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body)).value).toBe(fresh.value);
    expect(f.record().dirty).toBe(false);
    expect(await f.command({ action: "status", environment: "staging" })).toMatchObject({
      cookiePresent: true,
      browserExpiresAt: new Date(fresh.expirationDate * 1000).toISOString(),
    });
    expect(JSON.stringify([...f.data.values()])).not.toContain(syntheticCookie);
  });
  it.each([false, true])("fences both environments before waiting for either read (restart=%s)", async (restart) => {
    const f = fixture();
    const captured = { ...(await f.adapters.readCookie())!, expirationDate: 1_800_000_000 };
    const stagingReached = deferred<void>();
    const productionReached = deferred<void>();
    const stagingRead = deferred<OperatorCookie | null>();
    const productionRead = deferred<OperatorCookie | null>();
    vi.mocked(f.adapters.readCookie)
      .mockImplementationOnce(() => {
        stagingReached.resolve();
        return stagingRead.promise;
      })
      .mockImplementationOnce(() => {
        productionReached.resolve();
        return productionRead.promise;
      });
    const stagingPair = f.pair();
    await stagingReached.promise;
    const productionPair = f.pair(undefined, "production");
    await productionReached.promise;
    const fresh = { ...captured, value: `${syntheticCookie}_FRESH`, expirationDate: 1_900_000_000 };
    f.cookie(fresh);
    const change = f.background.cookieChanged({
      removed: false,
      cookie: { ...fresh, value: "EVENT_VALUE_NEVER_READ" },
    });
    await f.command({ action: "status", environment: "staging" });
    productionRead.resolve(captured);
    await productionPair;
    const productionStatus = await f.command({ action: "status", environment: "production" });
    const productionDirty = f.record("production").dirty;
    const sendsWhileStagingPaused = f.fetcher.mock.calls.length;
    stagingRead.resolve(captured);
    await Promise.all([stagingPair, change]);
    expect(sendsWhileStagingPaused).toBe(0);
    expect(productionStatus).toMatchObject({ cookiePresent: false, browserExpiresAt: null });
    expect(productionDirty).toBe(true);
    for (const environment of operatorEnvironments) {
      expect(await f.command({ action: "status", environment })).toMatchObject({
        cookiePresent: false,
        browserExpiresAt: null,
      });
      expect(f.record(environment).dirty).toBe(true);
    }
    expect(f.fetcher).not.toHaveBeenCalled();
    if (restart) await f.restart();
    f.advance(59_999);
    for (const environment of operatorEnvironments) await f.background.alarm(environment);
    expect(f.fetcher).not.toHaveBeenCalled();
    f.advance(1);
    for (const environment of operatorEnvironments) await f.background.alarm(environment);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://admin.staging.chasesets.com/api/public/catalog/operator-session/tcgplayer",
      "https://admin.chasesets.com/api/public/catalog/operator-session/tcgplayer",
    ]);
    for (const [, init] of f.fetcher.mock.calls) {
      expect(JSON.parse(String(init!.body)).value).toBe(fresh.value);
    }
    for (const environment of operatorEnvironments) {
      expect(f.record(environment).dirty).toBe(false);
      expect(await f.command({ action: "status", environment })).toMatchObject({
        cookiePresent: true,
        browserExpiresAt: new Date(fresh.expirationDate * 1000).toISOString(),
      });
    }
    expect(JSON.stringify([...f.data.values()])).not.toContain(syntheticCookie);
  });
  it.each([500, 502, 504])("HTTP %i retries only at five minutes, including after eviction", async (status) => {
    for (const restart of [false, true]) {
      for (const body of [
        JSON.stringify({ outcome: "stored", revision: 91, cookie: syntheticCookie }),
        "SYNTHETIC_HOSTILE_NON_JSON",
      ]) {
        const f = fixture();
        f.fetcher.mockImplementation(async () => new Response(body, { status }));
        await f.pair();
        expect(f.record()).toMatchObject({
          state: "retrying",
          lastOutcome: "unavailable",
          lastRevision: 0,
          lastPushedAt: null,
          dirty: true,
        });
        expect(JSON.stringify([...f.data.values()])).not.toContain("SYNTHETIC");
        if (restart) await f.restart();
        f.advance(299_999);
        await f.background.alarm("staging");
        expect(f.fetcher).toHaveBeenCalledTimes(1);
        f.advance(1);
        await f.background.alarm("staging");
        expect(f.fetcher).toHaveBeenCalledTimes(2);
        expect(f.record().lastRevision).toBe(0);
      }
    }
  });
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
