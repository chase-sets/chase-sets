import { describe, expect, it } from "vitest";
import {
  boundCredential,
  extensionProfileStates,
  parseExtensionCredential,
  parseExtensionProfile,
} from "../domain/extension-records";
import { admitConnectorTokens } from "../domain/extension-token-codec";
import { binding, extensionCredentialKey, extensionProfileKey, profile, storage, wire } from "./extension-test-support";

describe("extension-connector-record-schema", () => {
  it.each(["paired-idle", "paused", "unpairing"] as const)("accepts a bound durable credential for %s", (state) => {
    const row = profile(state);
    const credential = admitConnectorTokens(wire(), row, binding);
    expect(boundCredential(row, credential)).toEqual(credential);
  });
  it.each(extensionProfileStates)("accepts the closed %s row", (state) => {
    expect(parseExtensionProfile(profile(state))).toEqual(profile(state));
  });
  it("accepts paused cleanup-failed and both window boundaries", () => {
    expect(
      parseExtensionProfile({ ...profile("paused"), pauseReason: "cleanup-failed", servedPollWindowSeconds: 86400 })
        .state,
    ).toBe("paused");
  });
  it.each(["schemaVersion", "revision", "state", "connectionId", "servedPollWindowSeconds", "pauseReason"])(
    "rejects missing profile %s",
    (key) => {
      const row: Record<string, unknown> = { ...profile() };
      delete row[key];
      expect(() => parseExtensionProfile(row)).toThrow("invalid-record");
    },
  );
  const profileNegatives = [
    { schemaVersion: 2 },
    { revision: -1 },
    { revision: 0.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { state: "pairing" },
    { servedPollWindowSeconds: 29 },
    { servedPollWindowSeconds: 86401 },
    { servedPollWindowSeconds: 30.5 },
    { pauseReason: "operator" },
    { connectionId: "" },
    { connectionId: ["connection_A", "connection_B"] },
    { connectionId: { identity: "connection_A" } },
    { file: { bytes: "not-a-record" } },
    { connectionId: "connection A" },
  ];
  it.each(profileNegatives.map((patch, index) => [index, patch] as const))(
    "rejects profile negative %i",
    (_, patch) => {
      expect(() => parseExtensionProfile({ ...profile(), ...patch })).toThrow("invalid-record");
    },
  );
  it("paired-idle-null-accepted mutant: valid window and null pause cannot rescue a null identity", () => {
    expect(() => parseExtensionProfile({ ...profile(), connectionId: null })).toThrow("invalid-record");
  });
  it.each(extensionProfileStates)("enforces every nullable field for %s", (state) => {
    const row = profile(state);
    if (["paired-idle", "paused", "unpairing"].includes(state)) {
      expect(() => parseExtensionProfile({ ...row, connectionId: null })).toThrow();
      expect(() => parseExtensionProfile({ ...row, servedPollWindowSeconds: null })).toThrow();
      if (state === "paused") expect(() => parseExtensionProfile({ ...row, pauseReason: null })).toThrow();
    } else {
      for (const patch of [
        { connectionId: "connection_A" },
        { servedPollWindowSeconds: 30 },
        { pauseReason: "operator" },
      ])
        expect(() => parseExtensionProfile({ ...row, ...patch })).toThrow();
    }
  });
  const credentialKeys = [
    "schemaVersion",
    "issuer",
    "clientId",
    "connectionId",
    "accessToken",
    "refreshToken",
    "accessExpiresAt",
    "rotatedAt",
    "boundProfileRevision",
    "boundProfileState",
  ];
  it.each(credentialKeys)("rejects missing credential %s", (key) => {
    const row: Record<string, unknown> = { ...admitConnectorTokens(wire(), profile(), binding) };
    delete row[key];
    expect(() => parseExtensionCredential(row)).toThrow();
  });
  const credentialNegatives = [
    { accessExpiresAt: "2026-10-07" },
    { rotatedAt: "2026-10-07T12:00:00+00:00" },
    { rotatedAt: "2026-02-30T12:00:00Z" },
    { rotatedAt: "2026-10-07T25:00:00Z" },
    { issuer: "https://user:password@chase.example" },
    { issuer: "http://chase.example" },
    { clientId: "" },
    { accessToken: "agent_token" },
    { refreshToken: "cc_at_wrong" },
    { boundProfileRevision: -1 },
    { boundProfileRevision: Number.MAX_SAFE_INTEGER + 1 },
    { boundProfileState: "revoked" },
    { boundProfileState: "invalid" },
    { unknown: { nested: true } },
  ];
  it.each(credentialNegatives.map((patch, index) => [index, patch] as const))(
    "rejects credential negative %i",
    (_, patch) => {
      const valid = admitConnectorTokens(wire(), profile(), binding);
      expect(() => parseExtensionCredential({ ...valid, ...patch })).toThrow();
    },
  );
  it("requires all three fenced binding members and durable eligibility", () => {
    const valid = admitConnectorTokens(wire(), profile(), binding);
    for (const row of [
      profile("revoked"),
      { ...profile(), revision: 2 },
      { ...profile(), state: "paused" as const },
      { ...profile(), connectionId: "connection_B" },
    ])
      expect(() => boundCredential(row, valid)).toThrow();
  });
  it("valid v1 migration is twice byte/revision preserving without network", async () => {
    const rows = {
      [extensionProfileKey]: profile(),
      [extensionCredentialKey]: admitConnectorTokens(wire(), profile(), binding),
    };
    const fake = storage(rows);
    await fake.custody.inspect();
    await fake.custody.inspect();
    expect(fake.rows()).toEqual(rows);
    expect(fake.writes()).toBe(0);
    expect(fake.deletes()).toBe(0);
  });
  it("failed owned-v1 migration publishes only the advanced re-pair marker, then is idempotent", async () => {
    const fake = storage({ [extensionProfileKey]: { ...profile(), revision: 6, servedPollWindowSeconds: 29 } });
    expect(await fake.custody.inspect()).toEqual({ kind: "re-pair-required" });
    expect(fake.rows()).toEqual({ [extensionProfileKey]: profile("re-pair-required", 7) });
    const writes = fake.writes();
    await fake.custody.inspect();
    expect(fake.writes()).toBe(writes);
  });
});
