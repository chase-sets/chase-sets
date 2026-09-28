import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toJsonValue } from "@chase-sets/primitives/json";
import type { CatalogProductMeasureProfileRow } from "../read-model/queries";
import type { ProductMeasureProfileInput } from "./runtime";
import { z } from "zod";

export const productMeasureProfilesStream = "catalog.product-measure-profiles";
export const productMeasureProfileRecorded = "catalog.product-measure-profile.recorded";

const profileSchema = z.strictObject({
  profileId: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["active", "inactive"]).optional(),
  matchBlueprintId: z.string().min(1).nullable().optional(),
  matchCategoryIds: z.array(z.string().min(1)).optional(),
  matchSelectedOptions: z
    .array(z.strictObject({ dimensionId: z.string().min(1), optionId: z.string().min(1) }))
    .optional(),
  precedence: z.number().int().safe().optional(),
  unitLengthInches: z.number().positive(),
  unitWidthInches: z.number().positive(),
  unitHeightInches: z.number().positive(),
  unitWeightOunces: z.number().positive(),
  physicalFlags: z.array(z.enum(["raw-card", "slab", "sealed", "rigid", "bendable", "metal", "jumbo", "irregular"])),
  stackBehavior: z.enum(["stackable-thickness", "stackable-height", "non-stackable"]),
  confidence: z.enum(["measured", "provider", "conservative-estimate"]),
});

export async function readAuthoritativeProductMeasureProfiles(eventStore: EventStore) {
  const events = await readCompleteStream(eventStore, { streamId: productMeasureProfilesStream });
  const profiles = new Map<string, CatalogProductMeasureProfileRow>();
  const records = new Map<string, Readonly<{ profile: ProductMeasureProfileInput; revision: number }>>();
  for (const event of events) {
    if (event.eventType !== productMeasureProfileRecorded || !event.payload.profile) {
      throw new Error("Unknown Product Measure Profile history.");
    }
    const profile = event.payload.profile as unknown as ProductMeasureProfileInput;
    validateProfile(profile);
    records.set(profile.profileId, { profile, revision: event.streamVersion });
    profiles.set(profile.profileId, profileRow(profile, event.streamVersion, event.occurredAt));
  }
  return {
    revision: events.at(-1)?.streamVersion ?? 0,
    records,
    profiles: [...profiles.values()].sort((a, b) => a.precedence - b.precedence || a.key.localeCompare(b.key)),
  };
}

export async function recordProductMeasureProfile(
  eventStore: EventStore,
  profile: ProductMeasureProfileInput,
  context: EventStoreContext,
  mode: "replace" | "initialize" = "replace",
) {
  validateProfile(profile);
  const current = await readAuthoritativeProductMeasureProfiles(eventStore);
  const encoded = toJsonValue(profile);
  const prior = current.records.get(profile.profileId);
  if (prior && (mode === "initialize" || JSON.stringify(prior.profile) === JSON.stringify(encoded)))
    return prior.revision;
  await eventStore.appendToStream({
    streamId: productMeasureProfilesStream,
    expectedVersion: current.revision,
    context,
    events: [{ eventType: productMeasureProfileRecorded, payload: { profile: encoded } }],
  });
  return current.revision + 1;
}

function validateProfile(profile: ProductMeasureProfileInput) {
  profileSchema.parse(profile);
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
    status: profile.status ?? "active",
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
