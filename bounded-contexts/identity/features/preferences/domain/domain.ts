import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { ReducedMotionSetting } from "@chase-sets/design-system/motion/config";
import type { ColorMode, DensityMode } from "@chase-sets/design-system/theme/tokens";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import { assert, IdentityDomainError } from "../../../support/runtime-support/common";

export type PresentationColorMode = ColorMode;
export type PresentationDensity = DensityMode;
export type ReducedMotionPreference = ReducedMotionSetting;

export type UserPreferences = Readonly<{
  userId: UserId;
  colorMode: PresentationColorMode;
  density: PresentationDensity;
  reducedMotion: ReducedMotionPreference;
  locale: string;
  timeZone: string;
}>;

export type UserPreferencesState = Readonly<{
  userId: UserId | null;
  colorMode: PresentationColorMode;
  density: PresentationDensity;
  reducedMotion: ReducedMotionPreference;
  locale: string;
  timeZone: string;
}>;

export const defaultUserPresentationPreferences = {
  colorMode: "system",
  density: "comfortable",
  reducedMotion: "user",
  locale: "en",
  timeZone: "UTC",
} as const satisfies Omit<UserPreferences, "userId">;

export const initialUserPreferencesState: UserPreferencesState = {
  userId: null,
  ...defaultUserPresentationPreferences,
};

export type SetUserPreferencesCommand = Readonly<{
  type: "SetUserPreferences";
  userId: UserId;
  colorMode?: PresentationColorMode;
  density?: PresentationDensity;
  reducedMotion?: ReducedMotionPreference;
  locale?: string;
  timeZone?: string;
}>;

export type UserPreferencesCommand = SetUserPreferencesCommand;

export type UserPreferencesUpdatedEvent = DomainEvent<
  "identity.user-preferences.updated",
  Readonly<{
    userId: UserId;
    colorMode: PresentationColorMode;
    density: PresentationDensity;
    reducedMotion: ReducedMotionPreference;
    locale: string;
    timeZone: string;
  }>
>;

export type UserPreferencesEvent = UserPreferencesUpdatedEvent;

const supportedColorModes = ["system", "light", "dark"] as const satisfies readonly PresentationColorMode[];
const supportedDensities = ["comfortable", "compact"] as const satisfies readonly PresentationDensity[];
const supportedReducedMotionPreferences = [
  "user",
  "always",
  "never",
] as const satisfies readonly ReducedMotionPreference[];

export const decideUserPreferences: AggregateDecider<
  UserPreferencesState,
  UserPreferencesCommand,
  UserPreferencesEvent
> = (state, command) => {
  assert(state.userId === null || state.userId === command.userId, "User preferences belong to another user.");
  const target = normalizeUserPreferencesCommand(state, command);
  if (userPreferencesMatch(state, target)) {
    return [];
  }

  return [
    {
      type: "identity.user-preferences.updated",
      data: target,
    },
  ];
};

export const evolveUserPreferences: AggregateEvolver<UserPreferencesState, UserPreferencesEvent> = (_state, event) => ({
  userId: event.data.userId,
  colorMode: event.data.colorMode,
  density: event.data.density,
  reducedMotion: event.data.reducedMotion,
  locale: event.data.locale,
  timeZone: event.data.timeZone,
});

export function userPreferencesFor(userId: UserId, state: UserPreferencesState): UserPreferences {
  assert(state.userId === null || state.userId === userId, "User preferences belong to another user.");
  return {
    userId,
    colorMode: state.colorMode,
    density: state.density,
    reducedMotion: state.reducedMotion,
    locale: state.locale,
    timeZone: state.timeZone,
  };
}

function normalizeUserPreferencesCommand(
  state: UserPreferencesState,
  command: SetUserPreferencesCommand,
): UserPreferences {
  return {
    userId: command.userId,
    colorMode: normalizeColorMode(command.colorMode ?? state.colorMode),
    density: normalizeDensity(command.density ?? state.density),
    reducedMotion: normalizeReducedMotionPreference(command.reducedMotion ?? state.reducedMotion),
    locale: normalizeLocale(command.locale ?? state.locale),
    timeZone: normalizeTimeZone(command.timeZone ?? state.timeZone),
  };
}

function normalizeColorMode(value: PresentationColorMode): PresentationColorMode {
  assert(isSupportedValue(value, supportedColorModes), "Color mode must be system, light, or dark.");
  return value;
}

function normalizeDensity(value: PresentationDensity): PresentationDensity {
  assert(isSupportedValue(value, supportedDensities), "Density must be comfortable or compact.");
  return value;
}

function normalizeReducedMotionPreference(value: ReducedMotionPreference): ReducedMotionPreference {
  assert(isSupportedValue(value, supportedReducedMotionPreferences), "Reduced motion must be user, always, or never.");
  return value;
}

function normalizeLocale(value: string): string {
  const trimmed = value.trim();
  assert(trimmed.length > 0, "Locale is required.");

  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? trimmed;
  } catch {
    throw new IdentityDomainError("Locale must be a valid BCP 47 language tag.");
  }
}

function normalizeTimeZone(value: string): string {
  const trimmed = value.trim();
  assert(trimmed.length > 0, "Time zone is required.");

  try {
    return new Intl.DateTimeFormat("en", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    throw new IdentityDomainError("Time zone must be a valid IANA time zone.");
  }
}

function isSupportedValue<T extends string>(value: string, supportedValues: readonly T[]): value is T {
  return supportedValues.includes(value as T);
}

function userPreferencesMatch(left: UserPreferencesState, right: UserPreferences): boolean {
  return (
    left.colorMode === right.colorMode &&
    left.density === right.density &&
    left.reducedMotion === right.reducedMotion &&
    left.locale === right.locale &&
    left.timeZone === right.timeZone
  );
}

export type PreferenceChanges = Partial<Omit<UserPreferences, "userId">>;
export type PreferenceField = keyof typeof defaultUserPresentationPreferences;

const preferenceCanonicalizers = {
  colorMode: normalizeColorMode,
  density: normalizeDensity,
  reducedMotion: normalizeReducedMotionPreference,
  locale: normalizeLocale,
  timeZone: normalizeTimeZone,
} satisfies { [Field in PreferenceField]: (value: UserPreferences[Field]) => UserPreferences[Field] };

export function canonicalPreferenceChanges(body: unknown): PreferenceChanges {
  const fields = Object.keys(defaultUserPresentationPreferences).sort();
  assert(
    fields.length === Object.keys(preferenceCanonicalizers).length &&
      fields.every((field) => Object.hasOwn(preferenceCanonicalizers, field)),
    "INDETERMINATE preference field partition.",
  );
  assert(body !== null && typeof body === "object" && !Array.isArray(body), "User preferences are invalid.");
  const input = body as Record<string, unknown>;
  const supplied = Object.keys(input);
  assert(supplied.length > 0 && supplied.every((field) => fields.includes(field)), "User preferences are invalid.");
  const canonical: Record<string, string> = {};
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    assert(typeof value === "string" && value.length <= 128, "User preferences are invalid.");
    // The closed field partition and domain normalizers narrow every value.
    const normalize = preferenceCanonicalizers[field as PreferenceField] as (value: string) => string;
    canonical[field] = normalize(value as string);
  }
  return canonical as PreferenceChanges;
}

export function canonicalPreferences(userId: UserId, value: unknown): UserPreferences {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid preference history.");
  const object = value as Record<string, unknown>;
  assert(
    object.userId === userId &&
      Object.keys(object).length === Object.keys(defaultUserPresentationPreferences).length + 1,
    "Invalid preference history.",
  );
  const { userId: _userId, ...changes } = object;
  const canonical = canonicalPreferenceChanges(changes);
  assert(
    Object.keys(canonical).length === Object.keys(defaultUserPresentationPreferences).length,
    "Invalid preference history.",
  );
  assert(
    Object.entries(canonical).every(([key, scalar]) => object[key] === scalar),
    "Invalid preference history.",
  );
  return { userId, ...defaultUserPresentationPreferences, ...canonical };
}
