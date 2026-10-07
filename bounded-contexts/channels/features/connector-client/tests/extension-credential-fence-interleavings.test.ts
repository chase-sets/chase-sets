import { describe, expect, it } from "vitest";
import { createExtensionCredentialCustody } from "../domain/extension-credential-custody";
import { boundCredential } from "../domain/extension-records";
import {
  binding,
  deferred,
  extensionCredentialKey,
  extensionProfileKey,
  now,
  paired,
  profile,
  storage,
  wire,
} from "./extension-test-support";

describe("extension-credential-fence-interleavings", () => {
  it.each(["unpaired", "revoked", "cleanup-pending", "re-pair-required", "pairing-pending"] as const)(
    "late refresh cannot resurrect after %s",
    async (state) => {
      const fake = await paired();
      const captured = await fake.custody.capture("connection_A");
      const transport = deferred<ReturnType<typeof wire>>();
      const refresh = transport.promise.then((response) => fake.custody.refresh(captured.fence, response, now));
      await fake.custody.advance(captured.fence, profile(state));
      const writes = fake.writes();
      transport.resolve(wire());
      expect(await refresh).toBe("stale-response-discarded");
      expect(fake.writes()).toBe(writes);
      expect(fake.rows()[extensionCredentialKey]).toBeUndefined();
      expect(fake.log).toHaveBeenCalledWith("stale-response-discarded");
    },
  );
  it("fence-removed mutant: late exchange cannot replace a superseding null-identity pairing", async () => {
    const fake = storage();
    await fake.custody.inspect();
    await fake.custody.advance((await fake.custody.capture(null)).fence, profile("pairing-pending"));
    const first = await fake.custody.capture(null);
    await fake.custody.advance(first.fence, profile("pairing-pending"));
    const second = await fake.custody.capture(null);
    const pending = fake.rows();
    const writes = fake.writes();
    expect(await fake.custody.exchange(first.fence, wire(), binding)).toBe("stale-response-discarded");
    expect(fake.rows()).toEqual(pending);
    expect(fake.writes()).toBe(writes);
    expect(fake.rows()[extensionCredentialKey]).toBeUndefined();
    expect(await fake.custody.exchange(second.fence, wire("connection_B"), binding)).toBe("committed");
    const rows = fake.rows();
    expect(await fake.custody.exchange(first.fence, wire(), binding)).toBe("stale-response-discarded");
    expect(fake.rows()).toEqual(rows);
  });
  it("yielding read/write: two refresh commits share a lock, including distinct instances", async () => {
    const fake = await paired();
    const first = await fake.custody.capture("connection_A");
    const second = createExtensionCredentialCustody(fake.ports, fake.log);
    const results = await Promise.all([
      fake.custody.refresh(first.fence, wire(), now),
      second.refresh(first.fence, wire(), now),
    ]);
    expect(results).toEqual(["committed", "stale-response-discarded"]);
    const rows = fake.rows();
    expect(() =>
      boundCredential(rows[extensionProfileKey] as ReturnType<typeof profile>, rows[extensionCredentialKey]),
    ).not.toThrow();
  });
  it.each([true, false])("Auth one-use rotation late success/refusal, success-first=%s", async (successFirst) => {
    const fake = await paired();
    const capture = await fake.custody.capture("connection_A");
    const success = () => fake.custody.refresh(capture.fence, wire(), now);
    const refusal = () => fake.custody.refuse(capture.fence);
    if (successFirst) {
      expect(await success()).toBe("committed");
      expect(await refusal()).toBe("stale-response-discarded");
    } else {
      expect(await refusal()).toBe("refused");
      expect(await success()).toBe("committed");
    }
    const rows = fake.rows();
    expect(() =>
      boundCredential(rows[extensionProfileKey] as ReturnType<typeof profile>, rows[extensionCredentialKey]),
    ).not.toThrow();
  });
  it("keeps storage awaits inside the lock but not an awaiting transport", async () => {
    const fake = await paired();
    const capture = await fake.custody.capture("connection_A");
    const entered = deferred<void>();
    const release = deferred<void>();
    fake.pauseSet(async () => {
      entered.resolve();
      await release.promise;
    });
    const update = fake.custody.refresh(capture.fence, wire(), now);
    await entered.promise;
    const reads = fake.calls.filter((call) => call === "local:get").length;
    const unpair = fake.custody.advance(capture.fence, profile("unpaired"));
    await new Promise<void>((done) => setImmediate(done));
    const after = fake.calls.filter((call) => call === "local:get").length;
    release.resolve();
    expect(await update).toBe("committed");
    expect(await unpair).toBe("stale-response-discarded");
    expect(after).toBe(reads);
  });
  it("worker eviction reads only a consistent binding; a torn update requires re-pair", async () => {
    const fake = await paired();
    const restarted = storage(fake.rows());
    expect((await restarted.custody.inspect()).kind).toBe("ready");
    const torn = storage({ ...fake.rows(), [extensionProfileKey]: profile("paused", 99) });
    expect((await torn.custody.inspect()).kind).toBe("re-pair-required");
    expect(torn.rows()[extensionCredentialKey]).toBeUndefined();
    const capture = await fake.custody.capture("connection_A");
    await fake.custody.advance(capture.fence, profile("paused"));
    expect(await fake.custody.refresh(capture.fence, wire(), now)).toBe("stale-response-discarded");
  });
  it("connection/account substitution cannot read or rebind A's credential", async () => {
    const fake = await paired();
    await expect(fake.custody.capture("connection_B")).rejects.toThrow("unavailable");
    const capture = await fake.custody.capture("connection_A");
    const before = fake.rows();
    await expect(fake.custody.advance(capture.fence, { ...profile(), connectionId: "connection_B" })).rejects.toThrow(
      "invalid-record",
    );
    expect(await fake.custody.refresh(capture.fence, { ...wire(), account_id: "account_B" }, now)).toBe("refused");
    expect(fake.rows()).toEqual(before);
  });
});
