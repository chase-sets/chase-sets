import type { ColorMode } from "@chase-sets/design-system/theme/tokens";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import { describe, expect, it } from "vitest";
import {
  decideUserPreferences,
  defaultUserPresentationPreferences,
  evolveUserPreferences,
  initialUserPreferencesState,
  userPreferencesFor,
  type UserPreferences,
} from "./domain";

type TypeEquals<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;

const colorModeTypeMatchesDesignSystem: TypeEquals<UserPreferences["colorMode"], ColorMode> = true;
const userId = "usr_preferences" as UserId;

describe("user preferences domain", () => {
  it("resolves user-scoped presentation preference defaults before events exist", () => {
    expect(userPreferencesFor(userId, initialUserPreferencesState)).toEqual({
      userId,
      ...defaultUserPresentationPreferences,
    });
    expect(colorModeTypeMatchesDesignSystem).toBe(true);
  });

  it("sets complete user preferences from a partial command", () => {
    const events = decideUserPreferences(initialUserPreferencesState, {
      type: "SetUserPreferences",
      userId,
      colorMode: "dark",
    });
    const state = events.reduce(evolveUserPreferences, initialUserPreferencesState);

    expect(events).toEqual([
      {
        type: "identity.user-preferences.updated",
        data: {
          userId,
          colorMode: "dark",
          density: "comfortable",
          reducedMotion: "user",
          locale: "en",
          timeZone: "UTC",
        },
      },
    ]);
    expect(state).toEqual({
      userId,
      colorMode: "dark",
      density: "comfortable",
      reducedMotion: "user",
      locale: "en",
      timeZone: "UTC",
    });
  });

  it("normalizes and validates every presentation preference field", () => {
    const events = decideUserPreferences(initialUserPreferencesState, {
      type: "SetUserPreferences",
      userId,
      colorMode: "light",
      density: "compact",
      reducedMotion: "always",
      locale: " en-us ",
      timeZone: " America/Chicago ",
    });

    expect(events).toEqual([
      {
        type: "identity.user-preferences.updated",
        data: {
          userId,
          colorMode: "light",
          density: "compact",
          reducedMotion: "always",
          locale: "en-US",
          timeZone: "America/Chicago",
        },
      },
    ]);
  });

  it("keeps re-setting each existing field idempotent", () => {
    const state = decideUserPreferences(initialUserPreferencesState, {
      type: "SetUserPreferences",
      userId,
      colorMode: "dark",
      density: "compact",
      reducedMotion: "never",
      locale: "en-US",
      timeZone: "America/Chicago",
    }).reduce(evolveUserPreferences, initialUserPreferencesState);

    expect(decideUserPreferences(state, { type: "SetUserPreferences", userId, colorMode: "dark" })).toEqual([]);
    expect(decideUserPreferences(state, { type: "SetUserPreferences", userId, density: "compact" })).toEqual([]);
    expect(decideUserPreferences(state, { type: "SetUserPreferences", userId, reducedMotion: "never" })).toEqual([]);
    expect(decideUserPreferences(state, { type: "SetUserPreferences", userId, locale: "en-US" })).toEqual([]);
    expect(decideUserPreferences(state, { type: "SetUserPreferences", userId, timeZone: "America/Chicago" })).toEqual(
      [],
    );
  });

  it("rejects unsupported preference values", () => {
    expect(() =>
      decideUserPreferences(initialUserPreferencesState, {
        type: "SetUserPreferences",
        userId,
        colorMode: "sepia" as never,
      }),
    ).toThrow("Color mode must be system, light, or dark.");
    expect(() =>
      decideUserPreferences(initialUserPreferencesState, {
        type: "SetUserPreferences",
        userId,
        density: "crowded" as never,
      }),
    ).toThrow("Density must be comfortable or compact.");
    expect(() =>
      decideUserPreferences(initialUserPreferencesState, {
        type: "SetUserPreferences",
        userId,
        reducedMotion: "sometimes" as never,
      }),
    ).toThrow("Reduced motion must be user, always, or never.");
    expect(() =>
      decideUserPreferences(initialUserPreferencesState, {
        type: "SetUserPreferences",
        userId,
        locale: "not a locale",
      }),
    ).toThrow("Locale must be a valid BCP 47 language tag.");
    expect(() =>
      decideUserPreferences(initialUserPreferencesState, {
        type: "SetUserPreferences",
        userId,
        timeZone: "Mars/Base",
      }),
    ).toThrow("Time zone must be a valid IANA time zone.");
  });
});
