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
  if (state.userId === command.userId && userPreferencesMatch(state, target)) {
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
