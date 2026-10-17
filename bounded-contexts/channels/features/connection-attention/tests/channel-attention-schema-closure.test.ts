import { describe, expect, it } from "vitest";
import { channelAttentionResolutions } from "../domain/contracts";
import { decodeChannelAttentionFact, decodeChannelAttentionResolve } from "../domain/codecs";

const opened = {
  schemaVersion: "ChannelAttentionOpened/v1",
  connection: { connectionId: "connection_synthetic", accountId: "acc_synthetic" },
  reasonCode: "polling",
  generation: 1,
  resolutionReason: null,
  openedAt: "2026-09-13T12:00:00Z",
  resolvedAt: null,
};
describe("channel-attention-schema-closure", () => {
  it("closes both versioned facts and every resolution reason", () => {
    expect(decodeChannelAttentionFact(opened)).toEqual(opened);
    for (const resolutionReason of channelAttentionResolutions) {
      const resolved = {
        ...opened,
        schemaVersion: "ChannelAttentionResolved/v1",
        resolutionReason,
        resolvedAt: "2026-09-13T13:00:00+00:00",
      };
      expect(decodeChannelAttentionFact(resolved)).toEqual(resolved);
      const command = { connection: opened.connection, reasonCode: opened.reasonCode, generation: 1, resolutionReason };
      expect(decodeChannelAttentionResolve(command)).toEqual(command);
    }
  });
  it.each([
    { ...opened, rawException: "synthetic-provider-error" },
    { ...opened, body: "synthetic-provider-body" },
    { ...opened, connection: { ...opened.connection, credential: "credential-marker" } },
    { ...opened, connection: { ...opened.connection, seller: "seller-marker" } },
    { ...opened, reasonCode: "x".repeat(1024) },
    { ...opened, generation: 0 },
    { ...opened, generation: -1 },
    { ...opened, generation: 1.5 },
    { ...opened, openedAt: "2026-09-13T12:00:00" },
    { ...opened, resolutionReason: "no-action-required" },
    { ...opened, schemaVersion: "ChannelAttentionResolved/v1" },
    {
      ...opened,
      schemaVersion: "ChannelAttentionResolved/v1",
      resolutionReason: "no-action-required",
      resolvedAt: "2026-09-12T12:00:00Z",
    },
  ])("rejects unknown, unsafe, unbounded and inconsistent facts %#", (value) => {
    expect(() => decodeChannelAttentionFact(value)).toThrow();
  });
});
describe("channel-attention-artifact-secret-scan", () => {
  it("serializes only bounded account/connection references and closed reason codes", () => {
    const artifact = JSON.stringify(decodeChannelAttentionFact(opened));
    expect(artifact).not.toMatch(
      /credential-marker|seller-marker|rawException|provider-body|access_token|authorization|password/i,
    );
    expect(Object.keys(JSON.parse(artifact).connection).sort()).toEqual(["accountId", "connectionId"]);
  });
});
