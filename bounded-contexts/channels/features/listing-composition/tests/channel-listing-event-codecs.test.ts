import { describe, expect, it } from "vitest";
import {
  channelListingEventCodec,
  channelListingReconciliationEventCodec,
  channelPublicationConfigurationEventCodec,
} from "../domain/codecs";

describe("channel-listing-closed-event-history", () => {
  it("rejects unsupported event types in every retained aggregate", () => {
    for (const codec of [
      channelPublicationConfigurationEventCodec,
      channelListingEventCodec,
      channelListingReconciliationEventCodec,
    ]) {
      expect(() => codec.decode({ eventType: "channels.poisoned", payload: {} })).toThrow(
        "Unsupported Channels desired-state event type.",
      );
    }
  });

  it("rejects unknown nested keys instead of tolerating poisoned retained history", () => {
    expect(() =>
      channelPublicationConfigurationEventCodec.decode({
        eventType: "channels.channel-publication-configuration.settings-replaced",
        payload: {
          connectionId: "connection-1",
          settings: {
            titlePrefix: "",
            titleSuffix: "",
            descriptionFooter: "",
            categoryAllowlist: [],
            excludedListingIds: [],
            poisoned: true,
          },
        },
      }),
    ).toThrow("Invalid closed Channels desired-state event.");
  });
});
