import { describe, expect, it } from "vitest";
import {
  assertChannelPublicationSettingsPayload,
  channelListingEventCodec,
  channelListingReconciliationEventCodec,
  channelPublicationConfigurationEventCodec,
} from "../domain/codecs";

describe("channel-listing-closed-event-history", () => {
  const legacySettings = {
    titlePrefix: "",
    titleSuffix: "",
    descriptionFooter: "",
    categoryAllowlist: [],
    excludedListingIds: [],
  };

  it("decodes historical settings without a publish quantity cap as null", () => {
    expect(
      channelPublicationConfigurationEventCodec.decode({
        eventType: "channels.channel-publication-configuration.settings-replaced",
        payload: { connectionId: "connection-1", settings: legacySettings },
      }),
    ).toMatchObject({ data: { settings: { ...legacySettings, publishQuantityCap: null } } });
    expect(legacySettings).not.toHaveProperty("publishQuantityCap");
  });

  it.each([null, 1, 2, 1_000])("round-trips publish quantity cap %s", (publishQuantityCap) => {
    const settings = { ...legacySettings, publishQuantityCap };
    const original = {
      type: "channels.channel-publication-configuration.settings-replaced" as const,
      data: { connectionId: "connection-1", settings },
    };
    expect(
      channelPublicationConfigurationEventCodec.decode(channelPublicationConfigurationEventCodec.encode(original)),
    ).toEqual(original);
  });

  it.each([0, 1_001, 1.5, -1, "2", undefined])("rejects invalid publish quantity cap %s", (publishQuantityCap) => {
    const settings = { ...legacySettings, publishQuantityCap };
    expect(() => assertChannelPublicationSettingsPayload(settings)).toThrow();
    expect(() =>
      channelPublicationConfigurationEventCodec.decode({
        eventType: "channels.channel-publication-configuration.settings-replaced",
        payload: { connectionId: "connection-1", settings } as never,
      }),
    ).toThrow();
  });

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
