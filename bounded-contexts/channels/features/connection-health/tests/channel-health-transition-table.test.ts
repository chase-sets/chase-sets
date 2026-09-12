import { describe, expect, it } from "vitest";
import { channelConnectionStatuses } from "../../connections/domain/contracts";
import { channelHealthStates, type ChannelHealthState } from "../domain/contracts";
import { healthAvailability, healthTransitionAllowed } from "../domain/reducer";
import { consecutiveFailureThreshold } from "../domain/policy";

describe("channel-health-transition-table", () => {
  for (const status of [...channelConnectionStatuses, null])
    for (const health of channelHealthStates) {
      it(`${status}/${health} has one closed admission and availability outcome`, () => {
        expect(healthTransitionAllowed(status, health)).toBe(status === "active" || status === "pending-setup");
        const availability = healthAvailability(status, health, true);
        expect(availability.systemPaused).toBe(health === "failing");
        expect(availability.outboundPublicationAllowed).toBe(
          status === "active" && (health === "healthy" || health === "degraded"),
        );
        expect(availability.pollingAllowed).toBe(availability.outboundPublicationAllowed);
        expect(availability.verifiedInboundSaleAllowed).toBe(status !== null);
        expect(healthAvailability(status, health, false).outboundPublicationAllowed).toBe(false);
      });
    }
  it("kills the default-arm and inbound-not-paused mutants", () => {
    expect(healthTransitionAllowed("active", "unrecognized" as ChannelHealthState)).toBe(false);
    expect(healthAvailability("active", "unrecognized" as ChannelHealthState, true).outboundPublicationAllowed).toBe(
      false,
    );
    expect(healthAvailability("paused", "failing", false).verifiedInboundSaleAllowed).toBe(true);
  });
  it("reserves the ruled single-failure threshold for downstream connector liveness", () => {
    expect(consecutiveFailureThreshold("connector-liveness", 3)).toBe(1);
    expect(consecutiveFailureThreshold("polling", 3)).toBe(3);
  });
});
