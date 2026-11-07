import { describe, expect, it } from "vitest";
import { decideScanSession, evolveScanSession, initialScanSessionState, type ScanSessionCommand } from "./scan-session";

const product = { catalogItemId: "cat_1", dimensions: { language: "en" }, selectedOptions: { printing: "normal" } };
const command = (input: ScanSessionCommand) => decideScanSession(initialScanSessionState, input);

describe("scan lifecycle and retained-state commands", () => {
  it("requires account ownership, bounded opaque references, and complete products", () => {
    expect(() =>
      command({
        type: "StartScanSession",
        sessionId: "s1",
        accountId: "a1",
        purpose: "listing-intake",
        channel: "camera",
      }),
    ).not.toThrow();
    expect(() =>
      command({
        type: "CaptureScan",
        scanId: "x",
        assetRef: "https://example.test/image",
        capturedAt: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/not started/);
    const started = evolveScanSession(
      initialScanSessionState,
      command({
        type: "StartScanSession",
        sessionId: "s1",
        accountId: "a1",
        purpose: "listing-intake",
        channel: "camera",
      })[0],
    );
    expect(() =>
      decideScanSession(started, {
        type: "CaptureScan",
        scanId: "x",
        assetRef: "https://example.test/image",
        capturedAt: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/opaque/);
    expect(() =>
      decideScanSession(started, {
        type: "CaptureScan",
        scanId: "x",
        assetRef: "asset:opaque",
        capturedAt: "2026-01-01T00:00:00Z",
      }),
    ).not.toThrow();
    expect(() =>
      decideScanSession(started, {
        type: "ConfirmMatch",
        scanId: "x",
        product: { catalogItemId: "cat_1", dimensions: {}, selectedOptions: {} },
        candidateSource: "manual",
        confirmedAt: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/dimensions/);
  });

  it("rejects poisoned identity and enforces terminal completion", () => {
    const start = command({
      type: "StartScanSession",
      sessionId: "s1",
      accountId: "a1",
      purpose: "listing-intake",
      channel: "upload",
    })[0];
    const state = evolveScanSession(initialScanSessionState, start);
    expect(() =>
      evolveScanSession(state, {
        type: "scanning.scan-session.started",
        data: { sessionId: "s2", accountId: "a1", purpose: "listing-intake", channel: "upload" },
      }),
    ).toThrow(/identity/);
    expect(() =>
      decideScanSession(state, { type: "CompleteScanSession", completedAt: "2026-01-01T00:00:00Z" }),
    ).not.toThrow();
  });
});
