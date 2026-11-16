import { vi } from "vitest";
import { fixture, context, owner } from "./db-support";
import { parseTokenResponse, parseRefreshResponse } from "../domain/oauth";
import type { EbayOAuthProvider } from "../api/provider";
import type { ChannelHealthObservation } from "../../connection-health/domain/contracts";
import { createConnectionHealthRuntime } from "../../connection-health/api/runtime";
import { resolveChannelHealthPolicy } from "../../connection-health/api/policy";
import { createConnectorLivenessReader } from "../../connector-feed/read-model/liveness";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";

export const secretMarker = "synthetic-refresh-secret-marker";
// Shape only, derived through the executable mapper. S1 B#1/B#2 omitted refresh_token.
export const capturedS1RefreshShape = { expires_in: 7200, token_type: "User Access Token" };
export function refreshFixture(name: string) {
  const f = fixture(`refresh_${name}`);
  let instant = new Date("2026-11-16T00:00:00.000Z");
  const now = () => new Date(instant);
  const setNow = (at: string | Date) => {
    instant = new Date(at);
  };
  const advance = (seconds: number) => {
    instant = new Date(instant.getTime() + seconds * 1000);
  };
  function runtime(options: { changedMaterial?: boolean; lifetime?: number; terminal?: boolean } = {}) {
    instant = new Date("2026-11-16T00:00:00.000Z");
    const provider = {
      exchange: vi.fn(async () =>
        parseTokenResponse(
          {
            access_token: "synthetic-access-secret-marker",
            refresh_token: secretMarker,
            expires_in: options.lifetime ?? 7200,
            refresh_token_expires_in: 1000000,
            token_type: "User Access Token",
          },
          now().toISOString(),
        ),
      ),
      refresh: vi.fn(async (tokens) =>
        parseRefreshResponse(
          {
            ...capturedS1RefreshShape,
            access_token: options.changedMaterial ? `synthetic-access-${now().getTime()}` : tokens.accessToken,
          },
          now().toISOString(),
          tokens,
        ),
      ),
      identity: vi.fn(async () => "synthetic-seller"),
      revoke: vi.fn(async () => 200),
    } satisfies EbayOAuthProvider;
    const eventStore = createPostgresEventStore({ pool: f.db() });
    const health = createConnectionHealthRuntime({
      db: f.db(),
      eventStore,
      connectorLiveness: createConnectorLivenessReader(f.db()),
      resolvePolicy: (db, at) => resolveChannelHealthPolicy(eventStore, db, at),
      now: () => now().toISOString(),
    });
    const r = f.runtime({
      now,
      provider,
      eventStore,
      connectionHealth: health,
      ...(options.terminal ? { classifyRefreshFailure: () => "terminal" as const } : {}),
    });
    return { ...r, maintenance: r.service.credentialRefresh, now, provider, health };
  }
  const rows = async () =>
    (
      await f
        .db()
        .query(
          "SELECT connection_id,token_generation,schedule_generation,attempt,due_at,lease_id,lease_until,last_outcome FROM channels_ebay_credential_refresh ORDER BY connection_id",
        )
    ).rows;
  const observations = async () =>
    (
      await f.db().query<{
        observation: ChannelHealthObservation;
      }>("SELECT observation FROM channels_ebay_credential_refresh_outcomes ORDER BY token_generation,schedule_generation,attempt")
    ).rows.map((row) => row.observation);
  const restart = (provider: EbayOAuthProvider) => f.runtime({ now, provider }).service.credentialRefresh;
  return { ...f, runtime, restart, now, setNow, advance, rows, observations, context, owner };
}
