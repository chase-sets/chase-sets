import { describe, expect, it, vi } from "vitest";
import { createOperatorBackground } from "../../domain/extension/background";
import { operatorOrigins, type OperatorEnvironment } from "../../domain/extension/protocol";
import { emptyOperatorRecord, operatorRecordKey } from "../../domain/extension/record";
import { deferred, extensionId, fixture, sender, syntheticGrant, syntheticGrantB } from "./fixture";

const message = { action: "pair-handoff", grant: syntheticGrant };
const admin = (environment: OperatorEnvironment = "staging") => ({
  id: undefined as string | undefined,
  origin: operatorOrigins[environment] as string | undefined,
  url: `${operatorOrigins[environment]}/catalog/providers/tcgplayer` as string | undefined,
  frameId: 0 as number | undefined,
  hasTab: true,
});
function noEffects(f: ReturnType<typeof fixture>) {
  expect(f.adapters.storage.write).not.toHaveBeenCalled();
  expect(f.adapters.readCookie).not.toHaveBeenCalled();
  expect(f.adapters.schedule).not.toHaveBeenCalled();
  expect(f.adapters.badge).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
}

describe("operator-extension-pair-handoff", () => {
  it.each(["staging", "production"] as const)(
    "commits only the attested %s environment and returns one field",
    async (environment) => {
      const f = fixture();
      expect(await f.background.receiveHandoff(message, admin(environment), extensionId)).toEqual({
        outcome: "paired",
      });
      expect(f.record(environment).grant).toBe(syntheticGrant);
      const other = environment === "staging" ? "production" : "staging";
      expect(f.data.has(operatorRecordKey(other))).toBe(false);
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
      expect(String(f.fetcher.mock.calls[0]?.[0])).toContain(operatorOrigins[environment]);
    },
  );
  it.each([
    { origin: "https://example.test" },
    {
      origin: "http://admin.staging.chasesets.com",
      url: "http://admin.staging.chasesets.com/catalog/providers/tcgplayer",
    },
    { origin: undefined },
    { origin: "null", frameId: 10 },
    { origin: "https://admin.staging.chasesets.com.evil.test" },
    { url: undefined },
    { url: "not a URL" },
    { url: "https://admin.chasesets.com/catalog/providers/tcgplayer" },
    { url: "https://admin.staging.chasesets.com/catalog/providers/other" },
    { url: "https://admin.staging.chasesets.com/catalog/providers/tcgplayer/" },
    { frameId: 6 },
    { frameId: undefined },
    { hasTab: false },
    { id: "foreign" },
    { id: "" },
  ])("refuses attribution %j before privileged work", async (change) => {
    const f = fixture();
    expect(await f.background.receiveHandoff(message, { ...admin(), ...change }, extensionId)).toEqual({
      outcome: "refused",
    });
    noEffects(f);
  });
  it.each([
    null,
    [],
    {},
    { ...message, environment: "production" },
    { ...message, nested: {} },
    { ...message, grant: { value: syntheticGrant } },
    { ...message, grant: "B".repeat(43) },
    { ...message, grant: syntheticGrant + "=" },
    { ...message, action: "pair" },
    { action: "status" },
    { action: "unpair" },
    { action: "recover" },
  ])("refuses closed schema mutant %j without effects", async (value) => {
    const f = fixture();
    expect(await f.background.receiveHandoff(value, admin(), extensionId)).toEqual({ outcome: "refused" });
    noEffects(f);
  });
  it("accepts an own sender id and exact pathname with query/fragment", async () => {
    const f = fixture();
    expect(
      await f.background.receiveHandoff(
        message,
        { ...admin(), id: extensionId, url: admin().url + "?source=pair#handoff" },
        extensionId,
      ),
    ).toEqual({ outcome: "paired" });
  });
  it.each([
    undefined,
    { schemaVersion: 999 },
    { ...emptyOperatorRecord("staging"), profileRevision: Number.MAX_SAFE_INTEGER },
  ])("refuses inaccessible or blocked retained state without effects: %j", async (record) => {
    const f = fixture();
    f.adapters.storage.read = vi.fn(async () => {
      if (record === undefined) throw new Error("synthetic read failure");
      return record;
    });
    const background = createOperatorBackground(f.adapters);
    expect(await background.receiveHandoff(message, admin(), extensionId)).toEqual({ outcome: "refused" });
    noEffects(f);
  });
  it("never acknowledges a rejected write", async () => {
    const f = fixture();
    f.adapters.storage.write = vi.fn(async () => {
      throw new Error("synthetic write rejection");
    });
    expect(await f.background.receiveHandoff(message, admin(), extensionId)).toEqual({ outcome: "refused" });
    expect(f.data.size).toBe(0);
    expect(f.adapters.readCookie).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("acknowledges only after the grant write resolves, without waiting for badge work", async () => {
    const f = fixture();
    const started = deferred<void>();
    const commit = deferred<void>();
    const badge = deferred<void>();
    f.adapters.storage.write = vi.fn(async (key, record) => {
      if (!f.data.has(key)) {
        started.resolve();
        await commit.promise;
      }
      f.data.set(key, structuredClone(record));
    });
    f.adapters.badge = vi.fn(() => badge.promise);
    let outcome: unknown;
    const reply = f.background.receiveHandoff(message, admin(), extensionId).then((value) => {
      outcome = value;
    });
    await started.promise;
    expect(outcome).toBeUndefined();
    expect(f.data.size).toBe(0);
    expect(f.adapters.readCookie).not.toHaveBeenCalled();
    commit.resolve();
    await reply;
    expect(outcome).toEqual({ outcome: "paired" });
    expect(f.record().grant).toBe(syntheticGrant);
    badge.resolve();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  });
  it("refuses a trust failure without handoff effects", async () => {
    const f = fixture();
    f.adapters.storage.trust = vi.fn(async () => {
      throw new Error("synthetic trust failure");
    });
    const background = createOperatorBackground(f.adapters);
    expect(await background.receiveHandoff(message, admin(), extensionId)).toEqual({ outcome: "refused" });
    noEffects(f);
  });
  it("does not claim rollback when a write persists then rejects", async () => {
    const f = fixture();
    f.adapters.storage.write = vi.fn(async (key, record) => {
      f.data.set(key, structuredClone(record));
      throw new Error("synthetic uncertain commit");
    });
    expect(await f.background.receiveHandoff(message, admin(), extensionId)).toEqual({ outcome: "refused" });
    expect(f.record().grant).toBe(syntheticGrant);
    expect(f.adapters.storage.write).toHaveBeenCalledOnce();
  });
  it("acknowledges the durable commit despite badge failure", async () => {
    const f = fixture();
    f.adapters.badge = vi.fn(async () => {
      throw new Error("synthetic badge failure");
    });
    expect(await f.background.receiveHandoff(message, admin(), extensionId)).toEqual({ outcome: "paired" });
    expect(f.record().grant).toBe(syntheticGrant);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  });
  it("does not wait for a push, and a later 401 uses existing re-pair handling", async () => {
    const f = fixture();
    const response = deferred<Response>();
    f.fetcher.mockImplementationOnce(() => response.promise);
    expect(await f.background.receiveHandoff(message, admin(), extensionId)).toEqual({ outcome: "paired" });
    expect(f.record().grant).toBe(syntheticGrant);
    response.resolve(new Response(null, { status: 401 }));
    await vi.waitFor(() => expect(f.record().state).toBe("re-pair-required"));
    expect(f.record().grant).toBeNull();
  });
  it("a lost acknowledgement never rolls back a committed pair", async () => {
    const f = fixture();
    await f.background.receiveHandoff(message, admin(), extensionId).then(() => undefined);
    await vi.waitFor(() => expect(f.record().state).toBe("idle"));
    expect(f.record().grant).toBe(syntheticGrant);
    expect(f.record().profileRevision).toBe(1);
  });
  it.each(["idle", "retrying", "pushing", "error"] as const)(
    "identical grant in eligible %s state is a serialized zero-effect no-op",
    async (state) => {
      const f = fixture();
      const record = {
        ...emptyOperatorRecord("staging"),
        grant: syntheticGrant,
        state,
        profileRevision: Number.MAX_SAFE_INTEGER,
      };
      f.adapters.storage.read = vi.fn(async (key) => (key === operatorRecordKey("staging") ? record : undefined));
      const background = createOperatorBackground(f.adapters);
      expect(await background.receiveHandoff(message, admin(), extensionId)).toEqual({ outcome: "paired" });
      expect(await background.receiveHandoff(message, admin(), extensionId)).toEqual({ outcome: "paired" });
      noEffects(f);
    },
  );
  it("serializes concurrent identical handoffs into one grant commit", async () => {
    const f = fixture();
    const replies = await Promise.all([1, 2].map(() => f.background.receiveHandoff(message, admin(), extensionId)));
    expect(replies).toEqual([{ outcome: "paired" }, { outcome: "paired" }]);
    expect(f.record().profileRevision).toBe(1);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  });
  it.each(["idle", "re-pair-required"] as const)(
    "can replace a retained %s binding without migration",
    async (state) => {
      const f = fixture();
      const record = {
        ...emptyOperatorRecord("staging"),
        state,
        grant: state === "idle" ? syntheticGrantB : null,
        profileRevision: 7,
      };
      f.adapters.storage.read = vi.fn(async (key) => (key === operatorRecordKey("staging") ? record : undefined));
      const background = createOperatorBackground(f.adapters);
      expect(await background.receiveHandoff(message, admin(), extensionId)).toEqual({ outcome: "paired" });
      expect(f.record()).toMatchObject({ grant: syntheticGrant, profileRevision: 8, schemaVersion: 1 });
    },
  );
  it("keeps popup and external channels separate and popup pairing post-push", async () => {
    const f = fixture();
    expect(await f.background.receive(message, sender, extensionId)).toBeNull();
    expect(
      await f.background.receive(
        { action: "pair", environment: "staging", grant: syntheticGrant },
        { ...sender, hasTab: true },
        extensionId,
      ),
    ).toBeNull();
    expect(await f.background.receiveHandoff(message, { ...sender, frameId: 0 }, extensionId)).toEqual({
      outcome: "refused",
    });
    noEffects(f);
    f.fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await f.pair()).toMatchObject({ state: "re-pair-required", paired: false, lastOutcome: "grant-invalid" });
  });
});
