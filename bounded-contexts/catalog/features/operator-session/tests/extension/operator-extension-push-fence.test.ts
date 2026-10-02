import { describe, expect, it } from "vitest";
import { deferred, fixture, syntheticCookie, syntheticGrant, syntheticGrantB } from "./fixture";
import { operatorRecordKey } from "../../domain/extension/record";

describe("operator-extension-push-fence", () => {
  it.each([200, 409])("keeps B trailing while A's HTTP %i response is in flight", async (status) => {
    const f = fixture();
    const cookie = (await f.adapters.readCookie())!;
    const response = deferred<Response>();
    const sent = deferred<void>();
    f.fetcher.mockImplementationOnce(() => {
      sent.resolve();
      return response.promise;
    });
    const pairing = f.pair();
    await sent.promise;
    f.cookie({ ...cookie, value: `${syntheticCookie}_B` });
    const change = f.change();
    await f.command({ action: "status", environment: "staging" });
    response.resolve(Response.json({ outcome: status === 200 ? "stored" : "stale-revision", revision: 2 }, { status }));
    await Promise.all([pairing, change]);
    expect(f.record().dirty).toBe(true);
    expect(f.record().lastRevision).toBe(2);
    await f.restart();
    f.advance(59_999);
    await f.background.alarm("staging");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.fetcher.mockResolvedValueOnce(Response.json({ outcome: "stored", revision: 3 }));
    f.advance(1);
    await f.background.alarm("staging");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(f.fetcher.mock.calls[1]![1]!.body))).toMatchObject({
      expectedRevision: 2,
      value: `${syntheticCookie}_B`,
    });
    expect(f.record().lastRevision).toBe(3);
  });
  it("a malformed 401 still removes local authority without echoing the body", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ code: "SYNTHETIC_HOSTILE_BODY", extra: true }, { status: 401 }));
    await f.pair();
    expect(f.record().grant === null).toBe(true);
    expect(f.record().state).toBe("re-pair-required");
    f.advance(60_000);
    await f.command({ action: "recover", environment: "staging" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("discards A's stale response after B is paired", async () => {
    const f = fixture();
    const response = deferred<Response>();
    const sent = deferred<void>();
    f.fetcher.mockImplementationOnce(() => {
      sent.resolve();
      return response.promise;
    });
    const old = f.pair();
    await sent.promise;
    const newer = f.pair(syntheticGrantB);
    response.resolve(Response.json({ outcome: "stored", revision: 91 }));
    await Promise.all([old, newer]);
    expect(f.record().grant).toBe(syntheticGrantB);
    expect(f.record().lastRevision).toBe(0);
    f.advance(60_000);
    await f.background.alarm("staging");
    expect(f.fetcher.mock.calls[1]![1]!.headers).toHaveProperty("Authorization", `Bearer ${syntheticGrantB}`);
  });
  it("serializes a paused response write through completion before newer pairing", async () => {
    const f = fixture();
    const reached = deferred<void>();
    const release = deferred<void>();
    const write = f.adapters.storage.write;
    f.adapters.storage.write = async (key, value) => {
      if (value.lastRevision === 1) {
        reached.resolve();
        await release.promise;
      }
      await write(key, value);
    };
    const old = f.pair();
    await reached.promise;
    const newer = f.pair(syntheticGrantB);
    release.resolve();
    await Promise.all([old, newer]);
    expect(f.record().grant).toBe(syntheticGrantB);
    expect(f.record().lastRevision).toBe(0);
  });
  it("unpair removes authority before revoke and cannot delete a newer pairing", async () => {
    const f = fixture();
    await f.pair();
    const response = deferred<Response>();
    const reached = deferred<void>();
    f.fetcher.mockImplementationOnce(() => {
      reached.resolve();
      return response.promise;
    });
    const unpair = f.command({ action: "unpair", environment: "staging" });
    await reached.promise;
    expect(f.record().grant).toBeNull();
    await f.pair(syntheticGrantB);
    response.resolve(Response.json({ outcome: "revoked" }));
    await unpair;
    expect(f.record().grant).toBe(syntheticGrantB);
  });
  it("401 removes the grant, fences old work, badges and stays inert until explicit pairing", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ code: "grant-invalid" }, { status: 401 }));
    await f.pair();
    expect(f.record().grant).toBeNull();
    expect(f.record().state).toBe("re-pair-required");
    expect(f.adapters.badge).toHaveBeenLastCalledWith(true);
    f.advance(1_800_000);
    await f.restart();
    await f.change();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await f.pair(syntheticGrantB);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("409 adopts only the current validated fence and stops after three retries", async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () =>
      Response.json({ outcome: "stale-revision", revision: 2 }, { status: 409 }),
    );
    await f.pair();
    for (let retry = 0; retry < 5; retry++) {
      f.advance(60_000);
      await f.background.alarm("staging");
    }
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    expect(f.record().state).toBe("error");
    expect(JSON.parse(String(f.fetcher.mock.calls[1]![1]!.body)).expectedRevision).toBe(2);
  });
  it.each([2, "1", null])("unknown schema %j remains byte-identical across all entrypoints", async (schemaVersion) => {
    const f = fixture();
    const unknown = { schemaVersion, grant: syntheticGrant, opaque: { keep: true } };
    f.data.set(operatorRecordKey("staging"), unknown);
    await f.restart();
    await f.pair();
    await f.command({ action: "unpair", environment: "staging" });
    await f.background.alarm("staging");
    await f.change();
    expect(f.data.get(operatorRecordKey("staging"))).toEqual(unknown);
    expect(f.adapters.storage.write).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.command({ action: "status", environment: "staging" }))?.state).toBe("upgrade-required");
  });
});
