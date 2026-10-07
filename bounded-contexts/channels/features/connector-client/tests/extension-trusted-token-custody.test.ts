import { describe, expect, it, vi } from "vitest";
import { createExtensionCredentialCustody } from "../domain/extension-credential-custody";
import {
  binding,
  extensionCredentialKey,
  extensionProfileKey,
  now,
  paired,
  profile,
  storage,
  wire,
} from "./extension-test-support";

describe("extension-trusted-token-custody", () => {
  it("exhausted safe revision refuses without wrap or writes", async () => {
    const fake = storage({ [extensionProfileKey]: profile("unpaired", Number.MAX_SAFE_INTEGER) });
    const capture = await fake.custody.capture(null);
    await expect(fake.custody.advance(capture.fence, profile("pairing-pending"))).rejects.toThrow("revision-exhausted");
    expect(fake.writes()).toBe(0);
    expect(fake.deletes()).toBe(0);
  });
  it("storage-port-access-level: local and session are trusted before the first read or write", async () => {
    const fake = await paired();
    expect(fake.calls.slice(0, 3)).toEqual(["local:trusted", "session:trusted", "local:get"]);
    expect(fake.ports.local.setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(fake.ports.session.setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });
  it("failed access-level admission performs no storage IO and can retry without relaxing access", async () => {
    const fake = storage();
    vi.mocked(fake.ports.session.setAccessLevel).mockRejectedValueOnce(new Error("synthetic-denial"));
    await expect(fake.custody.inspect()).rejects.toThrow("synthetic-denial");
    expect(fake.calls).toEqual(["local:trusted"]);
    expect(fake.writes()).toBe(0);
    await fake.custody.inspect();
    expect(fake.calls.slice(1, 4)).toEqual(["local:trusted", "session:trusted", "local:get"]);
  });
  it("refresh and revoke expose only safe status/log codes and leave no credential marker", async () => {
    const fake = await paired();
    const capture = await fake.custody.capture("connection_A");
    const rotated = wire();
    expect(await fake.custody.refresh(capture.fence, rotated, now)).toBe("committed");
    const status = await fake.custody.inspect();
    expect(Object.keys(status).sort()).toEqual(["kind", "profile"]);
    const current = await fake.custody.capture("connection_A");
    await fake.custody.advance(current.fence, profile("revoked"));
    await fake.custody.refresh(capture.fence, rotated, now);
    expect(fake.log.mock.calls).toEqual([["stale-response-discarded"]]);
    expect(fake.rows()[extensionCredentialKey]).toBeUndefined();
    expect(fake.rows()[extensionProfileKey]).toEqual(profile("revoked", current.fence.revision + 1));
    expect(Object.keys(fake.ports)).toEqual(["local", "session"]);
    expect(Object.keys(fake.ports.session)).toEqual(["setAccessLevel"]);
  });
  it.each([2, 0, "future", undefined])(
    "delete-on-newer mutant: mixed v1/unknown version %s remains byte-identical",
    async (version) => {
      const first = await paired();
      const rows = {
        ...first.rows(),
        [extensionCredentialKey]: { schemaVersion: version, opaque: { bytes: [0, 255, 7] } },
      };
      const fake = storage(rows);
      const before = JSON.stringify(fake.rows());
      expect(await fake.custody.inspect()).toEqual({ kind: "upgrade-required" });
      expect(await fake.custody.inspect()).toEqual({ kind: "upgrade-required" });
      await expect(fake.custody.capture("connection_A")).rejects.toThrow("invalid-record");
      expect(JSON.stringify(fake.rows())).toBe(before);
      expect(fake.writes()).toBe(0);
      expect(fake.deletes()).toBe(0);
    },
  );
  it("unknown profile protects even a valid v1 credential from migration and stale writers", async () => {
    const first = await paired();
    const capture = await first.custody.capture("connection_A");
    const fake = storage({
      ...first.rows(),
      [extensionProfileKey]: { schemaVersion: 2, revision: 1, raw: "preserve" },
    });
    const before = fake.rows();
    expect((await fake.custody.inspect()).kind).toBe("upgrade-required");
    expect(await fake.custody.refresh(capture.fence, wire(), now)).toBe("stale-response-discarded");
    expect(fake.rows()).toEqual(before);
    expect(fake.writes()).toBe(0);
    expect(fake.deletes()).toBe(0);
  });
  it("interrupted terminal key removal restarts fail-closed and completes cleanup", async () => {
    const fake = await paired();
    const capture = await fake.custody.capture("connection_A");
    vi.mocked(fake.ports.local.remove).mockRejectedValueOnce(new Error("synthetic-eviction"));
    await expect(fake.custody.advance(capture.fence, profile("unpaired"))).rejects.toThrow("synthetic-eviction");
    const restart = storage(fake.rows());
    expect((await restart.custody.inspect()).kind).toBe("ready");
    expect(restart.rows()[extensionCredentialKey]).toBeUndefined();
    expect((await restart.custody.capture(null)).credential).toBeNull();
  });
  it("invalid wire identity/scope/closure never writes a pairing or refresh", async () => {
    const fake = storage({ [extensionProfileKey]: profile("pairing-pending") });
    const capture = await fake.custody.capture(null);
    const valid = wire();
    const { connection_id: _identity, ...omitted } = valid;
    const invalid = [
      omitted,
      { ...valid, connection_id: "" },
      { ...valid, connection_id: ["connection_A", "connection_A"] },
      { ...valid, connection_id: { value: "connection_A" } },
      { ...valid, unknown: true },
      { ...valid, scope: "agent:read" },
      { ...valid, scope: `${valid.scope} agent:read` },
      { ...valid, expires_in: -1 },
      { ...valid, token_type: "bearer" },
      { ...valid, access_token: { nested: "secret" } },
    ];
    for (const response of invalid)
      expect(await fake.custody.exchange(capture.fence, response, binding)).toBe("refused");
    expect(fake.writes()).toBe(0);
    expect(fake.deletes()).toBe(0);
    expect(await fake.custody.exchange(capture.fence, valid, binding)).toBe("committed");
    const active = await fake.custody.capture("connection_A");
    const before = fake.rows();
    for (const response of [...invalid, wire("connection_B"), valid])
      expect(await fake.custody.refresh(active.fence, response, now)).toBe("refused");
    expect(fake.rows()).toEqual(before);
  });
  it("serialization survives storage rejection and reuses the trusted worker", async () => {
    const fake = await paired();
    const capture = await fake.custody.capture("connection_A");
    vi.mocked(fake.ports.local.set).mockRejectedValueOnce(new Error("synthetic-write-failure"));
    await expect(fake.custody.refresh(capture.fence, wire(), now)).rejects.toThrow("synthetic-write-failure");
    const other = createExtensionCredentialCustody(fake.ports);
    expect(await other.refresh(capture.fence, wire(), now)).toBe("committed");
  });
});
