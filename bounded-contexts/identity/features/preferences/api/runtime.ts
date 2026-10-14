import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import { assert } from "../../../support/runtime-support/common";
import {
  canonicalPreferenceChanges,
  canonicalPreferences,
  decideUserPreferences,
  evolveUserPreferences,
  initialUserPreferencesState,
  userPreferencesFor,
  type UserPreferences,
} from "../domain/domain";
import { getUserPreferences } from "../read-model/queries";
import { buildUserPreferencesProjectionHandlers } from "../read-model/projection";
import {
  preferenceWriteAttemptEventType,
  preferenceWriteIdentity,
  readPreferenceWriteReceipt,
} from "../domain/write-attempt";
import type { PreferenceWriteResponse } from "./contracts";

export class PreferenceWriteConflict extends Error {
  readonly code = "preference_write_conflict";
  constructor(public readonly preferences: UserPreferences) {
    super("User preferences changed. Review the current preferences before saving again.");
  }
}

export type UserPreferencesServices = Readonly<{
  writeUserPreferences: (
    input: Readonly<{ userId: UserId; key: string; changes: unknown; context: EventStoreContext }>,
  ) => Promise<PreferenceWriteResponse>;
  getUserPreferences: (userId: string) => ReturnType<typeof getUserPreferences>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createUserPreferencesRuntime(deps: IdentityRuntimeDeps): UserPreferencesServices {
  const load = async (userId: UserId) => {
    const events = await readCompleteStream(deps.eventStore, { streamId: `identity.user-preferences-${userId}` });
    let state = initialUserPreferencesState;
    const states = [state];
    for (const event of events) {
      assert(event.eventType === "identity.user-preferences.updated", "Unexpected preference history.");
      const data = canonicalPreferences(userId, event.payload);
      state = evolveUserPreferences(state, { type: "identity.user-preferences.updated", data });
      states.push(state);
    }
    return { events, states, state, version: events.length, preferences: userPreferencesFor(userId, state) };
  };

  const writeUserPreferences: UserPreferencesServices["writeUserPreferences"] = async ({
    userId,
    key,
    changes,
    context,
  }) => {
    const identity = preferenceWriteIdentity(userId, key, canonicalPreferenceChanges(changes));
    const command = { type: "SetUserPreferences" as const, userId, ...identity.changes };
    const attempts = () => readCompleteStream(deps.eventStore, { streamId: identity.streamId, maxEvents: 1 });
    const resolveReplay = (history: Awaited<ReturnType<typeof load>>, events: readonly StoredEvent[]) => {
      if (events.length === 0) {
        assert(
          !history.events.some((business) => business.metadata.preferenceWriteKeyHash === identity.keyHash),
          "Preference business event has no atomic receipt.",
        );
        return null;
      }
      const event = events[0];
      assert(event.eventType === preferenceWriteAttemptEventType, "Unexpected preference write history.");
      const receipt = readPreferenceWriteReceipt(event.payload, userId, identity.keyHash);
      assert(
        history.events.filter((business) => business.metadata.preferenceWriteKeyHash === receipt.keyHash).length ===
          (receipt.outcome === "updated" ? 1 : 0),
        "Preference receipt has duplicate or missing business events.",
      );
      assert(receipt.preferenceVersion <= history.version, "Preference write receipt has no compatible history.");
      const recordedState = history.states[receipt.preferenceVersion];
      const business = history.events[receipt.preferenceVersion - 1];
      const ownsBusinessEvent = business?.metadata.preferenceWriteKeyHash === receipt.keyHash;
      assert(
        ownsBusinessEvent === (receipt.outcome === "updated"),
        "Preference write outcome is not paired with its business event.",
      );
      assert(
        JSON.stringify(userPreferencesFor(userId, recordedState)) === JSON.stringify(receipt.preferences),
        "Preference write receipt does not match its recorded version.",
      );
      const before = receipt.outcome === "updated" ? history.states[receipt.preferenceVersion - 1] : recordedState;
      assert(before !== undefined, "Preference write receipt has no compatible history.");
      const decided = decideUserPreferences(before, { type: "SetUserPreferences", userId, ...receipt.changes });
      assert(
        decided.length === (receipt.outcome === "updated" ? 1 : 0),
        "Preference write outcome does not match history.",
      );
      if (decided.length > 0) {
        assert(
          JSON.stringify(decided[0].data) === JSON.stringify(receipt.preferences),
          "Preference write result does not match history.",
        );
      }
      if (receipt.requestFingerprint !== identity.requestFingerprint)
        throw new PreferenceWriteConflict(history.preferences);
      return {
        id: userId,
        version: history.version,
        status: receipt.outcome,
        receipt,
        replayed: true,
        preferences: history.preferences,
      };
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let recorded = await attempts();
      const history = await load(userId);
      if (
        recorded.length === 0 &&
        history.events.some((business) => business.metadata.preferenceWriteKeyHash === identity.keyHash)
      ) {
        recorded = await attempts();
      }
      const replay = resolveReplay(history, recorded);
      if (replay) return replay;
      const events = decideUserPreferences(history.state, command);
      const state = events.reduce(evolveUserPreferences, history.state);
      const receipt = {
        schemaVersion: 1 as const,
        userId,
        keyHash: identity.keyHash,
        requestFingerprint: identity.requestFingerprint,
        changes: identity.changes,
        outcome: events.length > 0 ? ("updated" as const) : ("unchanged" as const),
        preferenceVersion: history.version + events.length,
        preferences: userPreferencesFor(userId, state),
      };
      assert(deps.eventStore.appendToStreams !== undefined, "Atomic preference writes are unavailable.");
      try {
        await deps.eventStore.appendToStreams!([
          {
            streamId: `identity.user-preferences-${userId}`,
            expectedVersion: history.version,
            events: events.map((event) => ({
              eventType: event.type,
              payload: event.data,
              metadata: { preferenceWriteKeyHash: identity.keyHash },
            })),
            context,
          },
          {
            streamId: identity.streamId,
            expectedVersion: "no_stream",
            events: [{ eventType: preferenceWriteAttemptEventType, payload: receipt }],
            context,
          },
        ]);
        const current = await load(userId);
        return {
          id: userId,
          version: current.version,
          status: receipt.outcome,
          receipt,
          replayed: false,
          preferences: current.preferences,
        };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "concurrency_conflict")) throw error;
        if (attempt === 1) {
          const history = await load(userId);
          throw new PreferenceWriteConflict(history.preferences);
        }
      }
    }
    throw new Error("Preference write exhausted its bounded attempts.");
  };

  return {
    writeUserPreferences,
    getUserPreferences: async (userId) => {
      const aggregate = await load(userId as UserId);
      if (aggregate.state.userId) {
        return userPreferencesFor(aggregate.state.userId, aggregate.state);
      }

      return getUserPreferences(deps.db, userId);
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-user-preferences-projection",
        handlers: buildUserPreferencesProjectionHandlers(deps.db),
      }),
    ],
  };
}
