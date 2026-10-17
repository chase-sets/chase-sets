import { describe, expect, it, vi } from "vitest";
import { backgroundFixture } from "./connector-background-test-support";
import { extensionProfileKey, profile } from "./extension-test-support";

describe("extension-connector-message-contract", () => {
  it("token-shaped extra status fields in storage are never forwarded", async () => {
    const f = backgroundFixture("paired-idle");
    await f.fake.ports.local.set({
      [extensionProfileKey]: { ...profile(), accessToken: "cc_at_secret", nested: { verifier: "secret" } },
    });
    const result = await f.command("status");
    expect(result).toMatchObject({ ok: true, status: { state: "re-pair-required", connectionId: null } });
    expect(JSON.stringify(result)).not.toMatch(/cc_at_|secret|verifier|nested|accessToken/);
  });
  it.each([
    null,
    [],
    "status",
    {},
    { type: "unknown" },
    { type: "status", token: "secret" },
    { type: "start-pairing", pairing_code: "secret" },
    { type: { type: "status" } },
    { type: "unpair", payload: {} },
    { type: "status", nested: { token: "secret" } },
  ])("refuses closed-schema violation %j without side effects", async (message) => {
    const f = backgroundFixture("paired-idle");
    expect(await f.message(message)).toEqual({ ok: false, error: "message-refused" });
    expect(f.fake.writes()).toBe(0);
    expect(f.ports.transport.request).not.toHaveBeenCalled();
    expect(f.ports.alarms.create).not.toHaveBeenCalled();
  });
  it("requires both the runtime id and the exact extension origin", async () => {
    const f = backgroundFixture("paired-idle");
    for (const sender of [
      { ...f.sender, id: "foreign" },
      { ...f.sender, origin: "https://chase.example" },
      { ...f.sender, origin: `${f.sender.origin}/page.html` },
      { id: f.sender.id },
      { origin: f.sender.origin },
      {},
    ]) {
      expect(await f.message({ type: "status" }, sender as typeof f.sender)).toEqual({
        ok: false,
        error: "message-refused",
      });
    }
    expect(f.fake.ports.local.get).not.toHaveBeenCalled();
    expect(await f.command("status")).toEqual({
      ok: true,
      status: {
        state: "paired-idle",
        connectionId: "connection_A",
        pauseReason: null,
        pollWindowSeconds: 30,
        pollWindowClamped: false,
      },
    });
  });
  it("projects only the closed status, never credential/session/file fields", async () => {
    const f = backgroundFixture("paired-idle");
    await f.session.ports.local.set({ token: "session-secret", file: new Uint8Array([1, 2]) });
    const value = await f.command("status");
    expect(JSON.stringify(value)).not.toMatch(/cc_at_|cc_rt_|verifier|session-secret|file|accessToken|refreshToken/);
    expect(Object.keys((value as { status: object }).status).sort()).toEqual([
      "connectionId",
      "pauseReason",
      "pollWindowClamped",
      "pollWindowSeconds",
      "state",
    ]);
    expect(f.fake.writes()).toBe(0);
    expect(f.ports.alarms.clear).not.toHaveBeenCalled();
    expect(vi.mocked(f.ports.identity.launchWebAuthFlow)).not.toHaveBeenCalled();
  });
});
