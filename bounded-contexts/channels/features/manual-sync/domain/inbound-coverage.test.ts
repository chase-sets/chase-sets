import { describe, expect, it } from "vitest";
import type { ConnectorAuthority } from "../../connector-feed/domain/contracts";
import { liveAuthority } from "./coverage-test-support";
import { resolveChannelInboundCoverage } from "./inbound-coverage";

const target = { accountId: "account-owner", connectionId: "connection-tcg" };
const absent = { state: "dark", reason: "no-inbound-authority" };

describe("manual-sync-connector-coverage", () => {
  it.each(["active", "paused"] as const)(
    "keeps %s live independently of claim/report membership",
    (connectionState) => {
      for (const claimReportAllowed of [false, true]) {
        expect(
          resolveChannelInboundCoverage({ ...liveAuthority(), connectionState, claimReportAllowed }, target),
        ).toEqual({ state: "live", reason: null });
      }
    },
  );

  it.each(["absent", "revoked"] as const)("maps canonical %s without inventing a health reason", (inbound) => {
    expect(resolveChannelInboundCoverage({ ...liveAuthority(), inbound, grant: null }, target)).toEqual({
      state: "dark",
      reason: inbound === "revoked" ? "inbound-authority-revoked" : "no-inbound-authority",
    });
  });

  it.each([
    null,
    undefined,
    {},
    true,
    [],
    { ...liveAuthority(), inbound: "unknown" },
    { ...liveAuthority(), inbound: {} },
    { ...liveAuthority(), connectionState: "pending-setup" },
    { ...liveAuthority(), connectionState: "disconnected" },
    { ...liveAuthority(), connectionState: "unknown" },
    { ...liveAuthority(), accountId: "foreign" },
    { ...liveAuthority(), connectionId: "foreign" },
    { ...liveAuthority(), pairingId: null },
    { ...liveAuthority(), claimReportAllowed: "true" },
    { ...liveAuthority(), lastSeenAt: "2099-01-01" },
    { ...liveAuthority(), grant: null },
    { ...liveAuthority(), grant: {} },
    ...["valid", "accountId", "connectionId", "pairingId", "revision", "expiresAt", "userId", "extra"].map((key) => ({
      ...liveAuthority(),
      grant: { ...liveAuthority().grant, [key]: key === "valid" ? "true" : {} },
    })),
    { ...liveAuthority(), grant: { ...liveAuthority().grant, valid: false } },
    { ...liveAuthority(), grant: { ...liveAuthority().grant, pairingId: "stale-pair" } },
  ])("fails closed for malformed, missing or unbound authority %#", (authority) => {
    expect(resolveChannelInboundCoverage(authority as ConnectorAuthority, target)).toEqual(absent);
  });

  it("does not promote a recent heartbeat or a truthy authority object", () => {
    expect(resolveChannelInboundCoverage({ ...liveAuthority(), inbound: "absent", grant: null }, target)).toEqual(
      absent,
    );
    expect(resolveChannelInboundCoverage({ lastSeenAt: "2099-01-01" } as never, target)).toEqual(absent);
  });
});
