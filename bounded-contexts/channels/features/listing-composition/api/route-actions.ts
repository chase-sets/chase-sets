import { assertChannelPublicationSettingsPayload } from "../domain/codecs";
import type { ChannelPublicationSettings } from "../domain/contracts";

export function parseChannelPublicationSettingsForm(formData: FormData): ChannelPublicationSettings {
  const cap = text(formData, "publishQuantityCap").trim();
  const settings: ChannelPublicationSettings = {
    titlePrefix: text(formData, "titlePrefix"),
    titleSuffix: text(formData, "titleSuffix"),
    descriptionFooter: text(formData, "descriptionFooter"),
    categoryAllowlist: lines(formData, "categoryAllowlist"),
    excludedListingIds: lines(formData, "excludedListingIds"),
    publishQuantityCap: cap === "" ? null : Number(cap),
  };
  assertChannelPublicationSettingsPayload(settings);
  return settings;
}

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? "");
}

function lines(data: FormData, key: string): readonly string[] {
  return [
    ...new Set(
      text(data, key)
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}
