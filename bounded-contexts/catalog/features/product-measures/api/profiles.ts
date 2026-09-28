import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toJsonValue } from "@chase-sets/primitives/json";
import type { CatalogProductMeasureProfileRow } from "../read-model/queries";
import type { ProductMeasureProfileInput } from "./runtime";

export const productMeasureProfilesStream = "catalog.product-measure-profiles";
export const productMeasureProfileRecorded = "catalog.product-measure-profile.recorded";

export async function readAuthoritativeProductMeasureProfiles(eventStore: EventStore) {
  const events = await readCompleteStream(eventStore, { streamId: productMeasureProfilesStream });
  const profiles = new Map<string, CatalogProductMeasureProfileRow>();
  for (const event of events) {
    if (event.eventType !== productMeasureProfileRecorded || !event.payload.profile) {
      throw new Error("Unknown Product Measure Profile history.");
    }
    const profile = event.payload.profile as unknown as ProductMeasureProfileInput;
    profiles.set(profile.profileId, profileRow(profile, event.streamVersion, event.occurredAt));
  }
  return {
    revision: events.at(-1)?.streamVersion ?? 0,
    profiles: [...profiles.values()].sort((a, b) => a.precedence - b.precedence || a.key.localeCompare(b.key)),
  };
}

export async function recordProductMeasureProfile(
  eventStore: EventStore,
  profile: ProductMeasureProfileInput,
  context: EventStoreContext,
) {
  if (
    !profile.profileId ||
    !profile.key ||
    !profile.name ||
    [profile.unitLengthInches, profile.unitWidthInches, profile.unitHeightInches, profile.unitWeightOunces].some(
      (value) => !Number.isFinite(value) || value <= 0,
    )
  ) {
    throw new Error("Product Measure Profile requires identity and positive finite physical measures.");
  }
  const current = await readAuthoritativeProductMeasureProfiles(eventStore);
  const encoded = toJsonValue(profile);
  const events = await readCompleteStream(eventStore, { streamId: productMeasureProfilesStream });
  const prior = [...events]
    .reverse()
    .find((event) => (event.payload.profile as { profileId?: string })?.profileId === profile.profileId);
  if (JSON.stringify(prior?.payload.profile) === JSON.stringify(encoded)) return;
  await eventStore.appendToStream({
    streamId: productMeasureProfilesStream,
    expectedVersion: current.revision,
    context,
    events: [{ eventType: productMeasureProfileRecorded, payload: { profile: encoded } }],
  });
}

function profileRow(
  profile: ProductMeasureProfileInput,
  revision: number,
  recordedAt: string,
): CatalogProductMeasureProfileRow {
  return {
    profile_id: profile.profileId,
    key: profile.key,
    name: profile.name,
    status: "active",
    match_blueprint_id: profile.matchBlueprintId ?? null,
    match_category_ids: profile.matchCategoryIds ?? [],
    match_selected_options: profile.matchSelectedOptions ?? [],
    precedence: profile.precedence ?? 100,
    updated_at: recordedAt,
    measure_snapshot: {
      catalogItemId: "",
      productId: "",
      selectedOptions: [],
      measureVersion: `${profile.key}:r${revision}`,
      unitLengthInches: profile.unitLengthInches,
      unitWidthInches: profile.unitWidthInches,
      unitHeightInches: profile.unitHeightInches,
      unitWeightOunces: profile.unitWeightOunces,
      physicalFlags: profile.physicalFlags,
      stackBehavior: profile.stackBehavior,
      source: "profile",
      confidence: profile.confidence,
    },
  };
}
