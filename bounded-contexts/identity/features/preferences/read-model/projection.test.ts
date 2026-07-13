import type { TransportEvent } from "@chase-sets/event-core";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { defaultUserPresentationPreferences } from "../domain/domain";
import { getUserPreferences, type UserPreferencesRow } from "./queries";
import { buildUserPreferencesProjectionHandlers } from "./projection";

type MemoryPreferencesDb = PgQueryable & {
  rows: Map<string, UserPreferencesRow>;
};

function createMemoryPreferencesDb(): MemoryPreferencesDb {
  const rows = new Map<string, UserPreferencesRow>();

  return {
    rows,
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("INSERT INTO identity_user_preferences")) {
        const [userId, colorMode, density, reducedMotion, locale, timeZone, updatedAt] = values;
        rows.set(String(userId), {
          user_id: String(userId),
          color_mode: colorMode as UserPreferencesRow["color_mode"],
          density: density as UserPreferencesRow["density"],
          reduced_motion: reducedMotion as UserPreferencesRow["reduced_motion"],
          locale: String(locale),
          time_zone: String(timeZone),
          updated_at: String(updatedAt),
        });
        return { rows: [] as Row[], rowCount: 1 };
      }

      if (sql.includes("FROM identity_user_preferences")) {
        const row = rows.get(String(values[0]));
        return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function preferencesEvent(
  data: Readonly<{
    userId?: string;
    colorMode?: "system" | "light" | "dark";
    density?: "comfortable" | "compact";
    reducedMotion?: "user" | "always" | "never";
    locale?: string;
    timeZone?: string;
  }> = {},
  recordedAt = "2026-06-26T15:00:00.000Z",
): TransportEvent {
  const userId = data.userId ?? "usr_preferences";
  return buildTransportEvent(
    "identity.user-preferences.updated",
    {
      userId,
      colorMode: data.colorMode ?? "dark",
      density: data.density ?? "comfortable",
      reducedMotion: data.reducedMotion ?? "user",
      locale: data.locale ?? "en-US",
      timeZone: data.timeZone ?? "America/Chicago",
    },
    {
      id: "evt_preferences",
      streamId: `identity.user-preferences-${userId}`,
      globalPosition: "1",
      tenantId: "tnt_test",
      audit: { performedByUserId: userId, forAccountId: "acc_test" },
      timing: { occurredAt: recordedAt, recordedAt },
    },
  );
}

describe("user preferences projection", () => {
  it("creates the read-model row from a user preference update event", async () => {
    const db = createMemoryPreferencesDb();
    const handlers = buildUserPreferencesProjectionHandlers(db);

    await handlers["identity.user-preferences.updated"]?.(preferencesEvent());

    expect(await getUserPreferences(db, "usr_preferences")).toEqual({
      userId: "usr_preferences",
      colorMode: "dark",
      density: "comfortable",
      reducedMotion: "user",
      locale: "en-US",
      timeZone: "America/Chicago",
    });
  });

  it("updates the same user row deterministically", async () => {
    const db = createMemoryPreferencesDb();
    const handlers = buildUserPreferencesProjectionHandlers(db);

    await handlers["identity.user-preferences.updated"]?.(preferencesEvent());
    await handlers["identity.user-preferences.updated"]?.(
      preferencesEvent(
        {
          colorMode: "light",
          density: "compact",
          reducedMotion: "always",
          locale: "fr-CA",
          timeZone: "America/Toronto",
        },
        "2026-06-26T15:01:00.000Z",
      ),
    );

    expect(db.rows.get("usr_preferences")).toEqual({
      user_id: "usr_preferences",
      color_mode: "light",
      density: "compact",
      reduced_motion: "always",
      locale: "fr-CA",
      time_zone: "America/Toronto",
      updated_at: "2026-06-26T15:01:00.000Z",
    });
  });

  it("replays from an empty read model to the latest preference snapshot", async () => {
    const db = createMemoryPreferencesDb();
    const handlers = buildUserPreferencesProjectionHandlers(db);

    await handlers["identity.user-preferences.updated"]?.(preferencesEvent({ colorMode: "system" }));
    db.rows.clear();
    await handlers["identity.user-preferences.updated"]?.(
      preferencesEvent({
        colorMode: "system",
        density: "comfortable",
        reducedMotion: "never",
        locale: "en-GB",
        timeZone: "Europe/London",
      }),
    );

    expect(await getUserPreferences(db, "usr_preferences")).toEqual({
      userId: "usr_preferences",
      colorMode: "system",
      density: "comfortable",
      reducedMotion: "never",
      locale: "en-GB",
      timeZone: "Europe/London",
    });
  });

  it("resolves defaults when the user has no projected preference row", async () => {
    const db = createMemoryPreferencesDb();

    expect(await getUserPreferences(db, "usr_without_preferences")).toEqual({
      userId: "usr_without_preferences",
      ...defaultUserPresentationPreferences,
    });
  });
});
