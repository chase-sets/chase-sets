import { describe, expect, it } from "vitest";
import { extensionId, fixture, sender, syntheticCookie, syntheticGrant } from "./fixture";
import { isCommand, isStatus } from "../../domain/extension/protocol";

describe("operator-extension-custody", () => {
  it.each([
    { id: "foreign" },
    { url: `${sender.origin}/sandbox.html` },
    { origin: "https://evil.test" },
    { hasTab: true },
  ])("rejects sender %j before any privileged call", async (change) => {
    const f = fixture();
    expect(
      await f.background.receive(
        { action: "pair", environment: "staging", grant: syntheticGrant },
        { ...sender, ...change },
        extensionId,
      ),
    ).toBeNull();
    // Initialization may restrict/read storage, but rejected input cannot write/read cookies/send.
    expect(f.adapters.storage.write).not.toHaveBeenCalled();
    expect(f.adapters.readCookie).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { action: "pair", environment: "other", grant: syntheticGrant },
    { action: "pair", environment: "staging", grant: { value: syntheticGrant } },
    { action: "pair", environment: "staging", grant: syntheticGrant, nested: {} },
    { action: "status", environment: "staging", grant: syntheticGrant },
    { action: "pair", environment: "staging", grant: "B".repeat(43) },
  ])("recursively refuses unknown/type/noncanonical input %j", async (value) => {
    const f = fixture();
    expect(isCommand(value)).toBe(false);
    expect(await f.background.receive(value, sender, extensionId)).toBeNull();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.adapters.storage.write).not.toHaveBeenCalled();
  });
  it("returns only closed non-secret status and stores no cookie/fingerprint", async () => {
    const f = fixture();
    const status = await f.pair();
    expect(isStatus(status)).toBe(true);
    expect(JSON.stringify(status)).not.toContain(syntheticCookie);
    expect(JSON.stringify(status)).not.toContain(syntheticGrant);
    expect(JSON.stringify([...f.data.values()])).not.toContain(syntheticCookie);
    expect(isStatus({ ...status, nested: { cookie: syntheticCookie } })).toBe(false);
    expect(isStatus({ ...status, serverRevision: 1.5 })).toBe(false);
    expect(isStatus({ ...status, lastPushedAt: "2026-01-01" })).toBe(false);
  });
});
