import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { authSchemaSql, authSessionEpochSchemaMigrations } from "../../../support/runtime-support/schema";
import {
  createAuthSessionPersistence,
  createAuthSessionEpochs,
  sessionAuthorityEventClassification,
  sessionOwnerKey,
  type AuthSessionEpochs,
} from "./owner-epochs";
import { foldSessionAuthority, sessionExpiry } from "./session-authority";
import type { AppendToStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";

const input = { sessionId: "ses_synthetic", userId: "usr_synthetic", tenantId: "tenant_synthetic" };
const start = {
  streamId: "auth.session-ses_synthetic",
  streamVersion: 1,
  tenantId: input.tenantId,
  eventType: "auth.session.started",
  payload: {
    ...input,
    accountId: "acc_synthetic",
    availableAccountIds: ["acc_synthetic"],
    authenticationMethod: "password",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
} as unknown as StoredEvent;

describe("Auth Session owner enrollment", () => {
  it.each(["auth", "identity", "synthetic-cohosted-store"])(
    "uses the canonical physical source incarnation even when its store name is %s",
    async (storeId) => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ store_id: storeId, incarnation: "synthetic-physical-incarnation" }] });
      const db = { query };
      const epochs = createAuthSessionEpochs(db as unknown as PgTransactionalPool);
      await expect(epochs.source(db)).resolves.toMatchObject({ captureGrant: expect.any(Function) });
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[0][0]).toContain("ON CONFLICT DO NOTHING");
      expect(query.mock.calls[1][0]).toBe(
        "SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true",
      );
    },
  );
  it.each([
    { rows: [] },
    { rows: [{ store_id: "auth", incarnation: "" }] },
    { rows: [{ store_id: "", incarnation: "synthetic-physical-incarnation" }] },
    { rows: [{ store_id: "auth" }] },
    {
      rows: [
        { store_id: "auth", incarnation: "synthetic-first" },
        { store_id: "auth", incarnation: "synthetic-second" },
      ],
    },
  ])("refuses absent, malformed or ambiguous physical source identity $rows", async ({ rows }) => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows });
    const db = { query };
    await expect(createAuthSessionEpochs(db as unknown as PgTransactionalPool).source(db)).rejects.toMatchObject({
      code: "concurrency_conflict",
    });
  });
  it("enrolls the closure DB proof and ships a ledgered token revision migration", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    const proof = "support/runtime-support/listing-session-epoch-closure.db.test.ts";
    expect(manifest.scripts["test:db"].split(/\s+/)).toContain(proof);
    expect(manifest.scripts["test:unit"]).toContain(`--exclude ${proof}`);
    expect(existsSync(new URL(`../../../${proof}`, import.meta.url))).toBe(true);
    expect(authSchemaSql).toContain(
      "revision bigint NOT NULL DEFAULT 1 CONSTRAINT identity_session_tokens_revision_check CHECK (revision > 0)",
    );
    const statements = authSessionEpochSchemaMigrations[0].statements;
    expect(statements[1]).toBe(
      "ALTER TABLE identity_session_tokens ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;",
    );
    expect(statements[2]).toContain(
      "ADD CONSTRAINT identity_session_tokens_revision_check CHECK (revision > 0) NOT VALID;",
    );
    expect(statements[3]).toBe(
      "ALTER TABLE identity_session_tokens VALIDATE CONSTRAINT identity_session_tokens_revision_check;",
    );
  });
  it("normalizes valid UTC expiry precision without accepting calendar rollover", () => {
    expect(sessionExpiry("2099-01-01T00:00:00Z")).toBe("2099-01-01T00:00:00.000Z");
    expect(sessionExpiry("2099-01-01T00:00:00.1Z")).toBe("2099-01-01T00:00:00.100Z");
  });
  it("classifies every Session event as consumed, including stream revision-only changes", () => {
    expect(Object.keys(sessionAuthorityEventClassification)).toEqual([
      "auth.session.started",
      "auth.session.account-switched",
      "auth.session.revoked",
      "auth.session.expired",
    ]);
    expect(sessionOwnerKey(start.streamId)).toBe("session/ses_synthetic");
    expect(sessionOwnerKey("auth.user-session-authority-usr_synthetic")).toBeUndefined();
    expect(sessionOwnerKey("auth.session-")).toBeUndefined();
  });
  it("excludes projections, retention after expiry and non-Session credentials from canonical authority", () => {
    const canonical = foldSessionAuthority([start], input);
    const projection = {
      status: "revoked",
      expires_at: "2000-01-01",
      last_seen_at: "2099-01-01",
      user_id: "usr_foreign",
    };
    projection.status = "active";
    expect(foldSessionAuthority([start], input)).toEqual(canonical);
    for (const streamId of [
      "auth.agent-grant-revocation-x",
      "identity.account-x",
      "auth.magic-link-x",
      "auth.phone-code-x",
      "auth.guest-checkout-x",
    ])
      expect(sessionOwnerKey(streamId)).toBeUndefined();
  });
  it("enrolls the key before the physical append and preserves multi-stream guards", async () => {
    const db = { query: vi.fn() };
    const appendToStreamsInTransaction = vi.fn().mockResolvedValue([{ storedEvents: [] }]);
    const raw = { appendToStreamsInTransaction } as unknown as PostgresEventStore;
    const transaction = vi.fn(async (keys, work) => {
      expect(keys).toEqual(["session/ses_synthetic"]);
      return work(db);
    });
    const epochs = { transaction } as unknown as AuthSessionEpochs;
    const store = createAuthSessionPersistence(raw, epochs);
    const changes = [
      { streamId: start.streamId, events: [{ eventType: "auth.session.revoked", payload: {} }] },
      { streamId: "auth.user-session-authority-usr_synthetic", events: [] },
    ] as unknown as AppendToStreamInput[];
    await store.appendToStreams!(changes);
    expect(appendToStreamsInTransaction).toHaveBeenCalledWith(db, changes);
    transaction.mockRejectedValueOnce(new Error("PENDING"));
    await expect(store.appendToStream(changes[0])).rejects.toThrow("PENDING");
    expect(appendToStreamsInTransaction).toHaveBeenCalledTimes(1);
  });
  it.each([{ configurationGrants: [{}] }, { requestTerminal: {} }])(
    "preserves the single-stream refusal for atomic terminal inputs %j",
    async (binding) => {
      const appendToStreamsInTransaction = vi.fn().mockResolvedValue([{ storedEvents: [] }]);
      const raw = { appendToStreamsInTransaction } as unknown as PostgresEventStore;
      const transaction = vi.fn(async (_keys, work) => work({ query: vi.fn() }));
      const store = createAuthSessionPersistence(raw, { transaction } as unknown as AuthSessionEpochs);
      await expect(
        store.appendToStream({
          streamId: start.streamId,
          events: [{ eventType: "auth.session.revoked", payload: {} }],
          ...binding,
        } as unknown as AppendToStreamInput),
      ).rejects.toMatchObject({ code: "concurrency_conflict" });
      expect(transaction).not.toHaveBeenCalled();
      expect(appendToStreamsInTransaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    "2026-01-01",
    "2026-02-30T00:00:00.000Z",
    "2026-01-01T00:00:00+01:00",
    "invalid",
    null,
    { expiresAt: "2099-01-01T00:00:00.000Z" },
    ["2099-01-01T00:00:00.000Z"],
  ])("refuses malformed or nested UTC expiry %j", (value) => {
    expect(() => sessionExpiry(value)).toThrow();
  });
  it.each([
    { ...start, tenantId: "tenant_foreign" },
    { ...start, streamVersion: 2 },
    { ...start, payload: { ...start.payload, userId: "usr_foreign" } },
    { ...start, payload: { ...start.payload, expiresAt: { date: "2099-01-01T00:00:00.000Z" } } },
  ])("refuses foreign and malformed complete Session history", (event) => {
    expect(() => foldSessionAuthority([event as StoredEvent], input)).toThrow();
  });
});
