import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import { defaultUserPresentationPreferences } from "../domain/domain";
import { createUserPreferencesRuntime } from "./runtime";

function createEmptyPreferencesDb(): PgQueryable {
  return {
    async query<Row>(sql: string) {
      if (sql.includes("FROM identity_user_preferences")) {
        return { rows: [] as Row[], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
    saveCheckpoint: async () => undefined,
  };
}

const context = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_preferences" as never,
    forAccountId: "acc_preferences" as never,
  },
};

describe("user preferences runtime", () => {
  it("serves committed preference aggregate state while the projection is still empty", async () => {
    const runtime = createUserPreferencesRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });

    await runtime.commandHandler({
      streamId: "identity.user-preferences-usr_preferences",
      command: {
        type: "SetUserPreferences",
        userId: "usr_preferences" as UserId,
        colorMode: "dark",
        reducedMotion: "always",
      },
      context,
    });

    await expect(runtime.getUserPreferences("usr_preferences")).resolves.toEqual({
      userId: "usr_preferences",
      colorMode: "dark",
      density: "comfortable",
      reducedMotion: "always",
      locale: "en",
      timeZone: "UTC",
    });
  });

  it("keeps defaults for users without committed preferences", async () => {
    const runtime = createUserPreferencesRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      checkpointStore: createCheckpointStore(),
      db: createEmptyPreferencesDb(),
    });

    await expect(runtime.getUserPreferences("usr_without_preferences")).resolves.toEqual({
      userId: "usr_without_preferences",
      ...defaultUserPresentationPreferences,
    });
  });
});
