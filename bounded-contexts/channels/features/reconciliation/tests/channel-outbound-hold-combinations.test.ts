import { describe, expect, it } from "vitest";
import { readChannelOutboundHold } from "../api/runtime";

describe("channel-outbound-hold-combinations", () => {
  it.each(
    Array.from({ length: 8 }, (_, mask) => ({
      seller: Boolean(mask & 1),
      health: Boolean(mask & 2),
      operator: Boolean(mask & 4),
    })),
  )("maps seller=$seller health=$health operator=$operator without a default arm", async (combination) => {
    const result = await readChannelOutboundHold({
      connection: {
        connectionId: "connection-1",
        providerKey: "synthetic-provider",
        status: combination.seller ? "paused" : "active",
      },
      healthHeld: combination.health,
      killSwitch: {
        heldProviderKeys: combination.operator ? ["synthetic-provider"] : [],
        heldConnectionIds: [],
      },
    });
    expect(result).toEqual({
      held: combination.seller || combination.health || combination.operator,
      sources: [
        ...(combination.seller ? (["seller-pause"] as const) : []),
        ...(combination.health ? (["health"] as const) : []),
        ...(combination.operator ? (["operator-kill"] as const) : []),
      ],
    });
  });

  it("fails closed when the operator policy is unavailable", async () => {
    await expect(
      readChannelOutboundHold({
        connection: { connectionId: "connection-1", providerKey: "synthetic-provider", status: "active" },
        healthHeld: false,
        killSwitch: null,
      }),
    ).resolves.toEqual({ held: true, sources: ["operator-kill"] });
  });
});
