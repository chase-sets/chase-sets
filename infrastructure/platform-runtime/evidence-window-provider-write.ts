import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";
import {
  ProviderWriteRefused,
  providerWriteIdempotencyKey,
  type EvidenceWindowProviderWrite,
  type ProviderWriteBinding,
  type ProviderWriteEnvelope,
  type ProviderWriteKey,
  type ProviderWriteResult,
  type ProviderWriteRow,
  type ReserveProviderWrite,
} from "@chase-sets/evidence-window-provider-write";
import {
  providerWriteDigest,
  providerWriterShape,
  validProviderReference,
  validateProviderBinding,
  validateProviderMaterial,
} from "@chase-sets/evidence-window-provider-write/material";

export const evidenceWindowProviderWriteSchemaSql = `
CREATE TABLE IF NOT EXISTS evidence_window_provider_write (
  window_id text NOT NULL REFERENCES evidence_window(window_id) CHECK (window_id ~ '^[0-9a-f]{32}$'),
  object_class integer NOT NULL CHECK (object_class BETWEEN 1 AND 6),
  creation_ordinal integer NOT NULL CHECK (creation_ordinal BETWEEN 1 AND 64),
  operation text NOT NULL CHECK (operation IN ('create', 'dispose')),
  writer_kind text NOT NULL CHECK (writer_kind IN ('customer', 'setup-embedded', 'setup-hosted', 'payment-saved',
    'payment-checkout', 'payment-agentic', 'cancel-payment', 'cancel-setup', 'connect-setup', 'connect-manage', 'connect-notification')),
  logical_operation_id text NOT NULL CHECK (octet_length(logical_operation_id) BETWEEN 1 AND 256),
  owner_account_id text NOT NULL CHECK (octet_length(owner_account_id) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed', 'ambiguous')),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  observed_class integer NULL CHECK (observed_class BETWEEN 1 AND 6),
  reused_existing boolean NOT NULL DEFAULT false,
  replay_attempts integer NOT NULL DEFAULT 0 CHECK (replay_attempts IN (0, 1)),
  logical_slot integer NULL CHECK (logical_slot BETWEEN 1 AND 3),
  body_kind text NULL CHECK (body_kind IN ('absent', 'form')),
  body_text text NULL CHECK (octet_length(body_text) <= 65536),
  method text NULL CHECK (method = 'POST'),
  endpoint text NULL,
  target text NULL CHECK (target ~ '^[a-zA-Z0-9_]{1,256}$'),
  account_scope text NULL CHECK (account_scope IN ('platform', 'connected')),
  connected_account_reference text NULL CHECK (connected_account_reference ~ '^[a-zA-Z0-9_]{1,256}$'),
  api_version text NULL,
  digest text NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  provider_reference text NULL CHECK (provider_reference ~ '^[a-zA-Z0-9_]{1,256}$'),
  response_expires_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  replay_deadline timestamptz NOT NULL,
  PRIMARY KEY (window_id, object_class, creation_ordinal, operation),
  UNIQUE (window_id, writer_kind, logical_operation_id, operation),
  CHECK ((logical_slot IS NOT NULL) = (object_class = 6 AND operation = 'create')),
  CHECK (logical_slot IS NULL OR creation_ordinal = logical_slot),
  CHECK (logical_slot IS NULL OR (logical_slot = 1 AND writer_kind = 'connect-setup')
    OR (logical_slot = 2 AND writer_kind = 'connect-manage') OR (logical_slot = 3 AND writer_kind = 'connect-notification')),
  CHECK ((state = 'succeeded' AND NOT (object_class = 6 AND operation = 'create')) = (provider_reference IS NOT NULL)),
  CHECK (NOT (object_class = 6 AND operation = 'create') OR provider_reference IS NULL),
  CHECK (reused_existing = false OR (writer_kind = 'customer' AND state = 'succeeded' AND object_class = 5)),
  CHECK ((reused_existing AND body_kind IS NULL AND body_text IS NULL AND method IS NULL AND endpoint IS NULL
      AND target IS NULL AND account_scope IS NULL AND connected_account_reference IS NULL AND api_version IS NULL AND digest IS NULL)
    OR (NOT reused_existing AND body_kind IS NOT NULL AND method IS NOT NULL AND endpoint IS NOT NULL
      AND account_scope IS NOT NULL AND api_version IS NOT NULL AND digest IS NOT NULL
      AND ((body_kind = 'absent' AND body_text IS NULL) OR (body_kind = 'form' AND body_text IS NOT NULL))
      AND ((account_scope = 'connected') = (connected_account_reference IS NOT NULL))
      AND ((operation = 'dispose') = (target IS NOT NULL)))),
  CHECK (replay_deadline >= created_at AND replay_deadline <= created_at + interval '82800 seconds'),
  CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_window_provider_write_slot_idx
  ON evidence_window_provider_write(window_id, logical_slot) WHERE logical_slot IS NOT NULL;
`;

type StoredRow = {
  window_id: string;
  object_class: ProviderWriteKey["objectClass"];
  creation_ordinal: number;
  operation: ProviderWriteKey["operation"];
  writer_kind: ProviderWriteBinding["writerKind"];
  logical_operation_id: string;
  owner_account_id: string;
  state: ProviderWriteRow["state"];
  version: number;
  observed_class: ProviderWriteRow["observedClass"];
  reused_existing: boolean;
  replay_attempts: 0 | 1;
  logical_slot: 1 | 2 | 3 | null;
  body_kind: ProviderWriteEnvelope["bodyKind"] | null;
  body_text: string | null;
  method: "POST" | null;
  endpoint: string | null;
  target: string | null;
  account_scope: ProviderWriteEnvelope["accountScope"] | null;
  connected_account_reference: string | null;
  api_version: string | null;
  digest: string | null;
  provider_reference: string | null;
  response_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  replay_deadline: Date | string;
};
const instant = (value: Date | string) => new Date(value).toISOString();
const keyValues = (key: ProviderWriteKey) => [key.windowId, key.objectClass, key.creationOrdinal, key.operation];
const fullKey = "window_id = $1 AND object_class = $2 AND creation_ordinal = $3 AND operation = $4";
const guardedKey = `${fullKey} AND version = $5 AND version < 2147483647`;
const refused = (code: Extract<ProviderWriteResult, { kind: "refused" }>["code"]): ProviderWriteResult => ({
  kind: "refused",
  code,
});

function mapRow(row: StoredRow): ProviderWriteRow {
  return {
    key: {
      windowId: row.window_id,
      objectClass: row.object_class,
      creationOrdinal: row.creation_ordinal,
      operation: row.operation,
    },
    binding: {
      writerKind: row.writer_kind,
      logicalOperationId: row.logical_operation_id,
      ownerAccountId: row.owner_account_id,
    },
    envelope:
      row.body_kind === null
        ? null
        : {
            bodyKind: row.body_kind,
            bodyText: row.body_text,
            method: row.method!,
            endpoint: row.endpoint!,
            target: row.target,
            accountScope: row.account_scope!,
            connectedAccountReference: row.connected_account_reference,
            apiVersion: row.api_version!,
          },
    digest: row.digest,
    state: row.state,
    version: row.version,
    observedClass: row.observed_class,
    reusedExisting: row.reused_existing,
    replayAttempts: row.replay_attempts,
    logicalSlot: row.logical_slot,
    providerReference: row.provider_reference,
    responseExpiresAt: row.response_expires_at === null ? null : instant(row.response_expires_at),
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
    replayDeadline: instant(row.replay_deadline),
  };
}

function sameBinding(a: ProviderWriteBinding, b: ProviderWriteBinding): boolean {
  return (
    a.writerKind === b.writerKind &&
    a.logicalOperationId === b.logicalOperationId &&
    a.ownerAccountId === b.ownerAccountId
  );
}

export function createPostgresEvidenceWindowProviderWrite(db: PgTransactionalPool): EvidenceWindowProviderWrite {
  async function safe(action: () => Promise<ProviderWriteResult>): Promise<ProviderWriteResult> {
    try {
      return await action();
    } catch (error) {
      return refused(
        error instanceof ProviderWriteRefused && error.code !== "stale-write-rejected" ? error.code : "storage-failed",
      );
    }
  }

  async function readKey(query: PgQueryable, key: ProviderWriteKey): Promise<ProviderWriteRow | null> {
    const result = await query.query<StoredRow>(
      `SELECT * FROM evidence_window_provider_write WHERE ${fullKey}`,
      keyValues(key),
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async function reserve(input: ReserveProviderWrite, reuse: string | null): Promise<ProviderWriteResult> {
    validateProviderBinding(input.binding);
    if (
      !/^[0-9a-f]{32}$/.test(input.windowId) ||
      !Number.isInteger(input.retentionSeconds) ||
      input.retentionSeconds < 3600 ||
      input.retentionSeconds > 82800
    )
      return refused("invalid-identity");
    if (reuse !== null && !validProviderReference(reuse)) return refused("unsafe-material");
    const shape = providerWriterShape(input.binding);
    if (reuse === null) {
      validateProviderMaterial(input.binding, input.envelope);
      if (input.envelope.apiVersion !== STRIPE_API_VERSION) return refused("unsafe-material");
    }
    const digest = reuse === null ? await providerWriteDigest(input.envelope) : null;
    async function resolveExisting(stored: StoredRow): Promise<ProviderWriteResult> {
      const row = mapRow(stored);
      if (
        !sameBinding(row.binding, input.binding) ||
        row.key.objectClass !== shape.objectClass ||
        row.logicalSlot !== shape.logicalSlot
      )
        return refused("binding-drift");
      if (reuse !== null && row.state === "succeeded" && row.providerReference === reuse)
        return { kind: "existing", row };
      if (
        row.digest !== digest ||
        row.reusedExisting !== (reuse !== null) ||
        (reuse !== null && row.providerReference !== reuse)
      )
        return refused("binding-drift");
      if (row.envelope && (await providerWriteDigest(row.envelope)) !== row.digest) return refused("unsafe-material");
      return { kind: "existing", row };
    }
    return withPgTransaction(db, async (tx) => {
      if (shape.logicalSlot === null)
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `provider-write:${input.windowId}:${shape.objectClass}`,
        ]);
      const findExisting = () =>
        tx.query<StoredRow>(
          `SELECT * FROM evidence_window_provider_write WHERE window_id = $1 AND
          ((writer_kind = $2 AND logical_operation_id = $3 AND operation = $4) OR ($5::integer IS NOT NULL AND logical_slot = $5))`,
          [
            input.windowId,
            input.binding.writerKind,
            input.binding.logicalOperationId,
            shape.operation,
            shape.logicalSlot,
          ],
        );
      const existing = await findExisting();
      if (existing.rows[0]) return resolveExisting(existing.rows[0]);
      const authority = await tx.query<{ expires_at: Date | string; created_at: Date | string }>(
        `SELECT expires_at, statement_timestamp() AS created_at FROM evidence_window
         WHERE window_id = $1 AND state = 'open' AND expires_at > statement_timestamp() FOR SHARE`,
        [input.windowId],
      );
      if (!authority.rows[0]) return refused("window-ineligible");
      let ordinal: number | null = shape.logicalSlot;
      if (shape.operation === "dispose") {
        const original = input.originalKey && (await readKey(tx, { ...input.originalKey, operation: "create" }));
        if (
          !original ||
          original.key.windowId !== input.windowId ||
          original.key.objectClass !== shape.objectClass ||
          original.binding.ownerAccountId !== input.binding.ownerAccountId ||
          original.providerReference !== input.envelope.target ||
          input.binding.logicalOperationId !== providerWriteIdempotencyKey(original.key)
        )
          return refused("invalid-identity");
        ordinal = original.key.creationOrdinal;
      } else if (ordinal === null) {
        const count = await tx.query<{ ordinal: number }>(
          `SELECT COALESCE(MAX(creation_ordinal), 0)::integer + 1 AS ordinal FROM evidence_window_provider_write
           WHERE window_id = $1 AND object_class = $2`,
          [input.windowId, shape.objectClass],
        );
        ordinal = count.rows[0]!.ordinal;
      }
      if (ordinal > 64) return refused("ordinal-exhausted");
      const createdAt = instant(authority.rows[0].created_at);
      const deadline = new Date(
        Math.min(
          new Date(createdAt).getTime() + input.retentionSeconds * 1000,
          new Date(authority.rows[0].expires_at).getTime(),
        ),
      ).toISOString();
      const envelope = reuse === null ? input.envelope : null;
      const result = await tx.query<StoredRow>(
        `INSERT INTO evidence_window_provider_write (
          window_id, object_class, creation_ordinal, operation, writer_kind, logical_operation_id, owner_account_id,
          state, version, reused_existing, logical_slot, body_kind, body_text, method, endpoint, target, account_scope,
          connected_account_reference, api_version, digest, provider_reference, created_at, updated_at, replay_deadline
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,$22)
        ON CONFLICT DO NOTHING RETURNING *`,
        [
          input.windowId,
          shape.objectClass,
          ordinal,
          shape.operation,
          input.binding.writerKind,
          input.binding.logicalOperationId,
          input.binding.ownerAccountId,
          reuse === null ? "pending" : "succeeded",
          reuse !== null,
          shape.logicalSlot,
          envelope?.bodyKind ?? null,
          envelope?.bodyText ?? null,
          envelope?.method ?? null,
          envelope?.endpoint ?? null,
          envelope?.target ?? null,
          envelope?.accountScope ?? null,
          envelope?.connectedAccountReference ?? null,
          envelope?.apiVersion ?? null,
          digest,
          reuse,
          createdAt,
          deadline,
        ],
      );
      if (!result.rows[0]) {
        const winner = await findExisting();
        return winner.rows[0] ? resolveExisting(winner.rows[0]) : refused("binding-drift");
      }
      return { kind: "reserved", row: mapRow(result.rows[0]) };
    });
  }

  async function update(
    key: ProviderWriteKey,
    version: number,
    set: string,
    condition: string,
    values: readonly unknown[],
  ): Promise<ProviderWriteResult> {
    const result = await db.query<StoredRow>(
      `UPDATE evidence_window_provider_write SET ${set}, version = version + 1, updated_at = statement_timestamp()
       WHERE ${guardedKey} AND ${condition} RETURNING *`,
      [...keyValues(key), version, ...values],
    );
    return result.rows[0] ? { kind: "existing", row: mapRow(result.rows[0]) } : { kind: "stale-write-rejected" };
  }

  return {
    reserveOrResolve: (input) => safe(() => reserve(input, null)),
    observeCustomerReuse: (input) =>
      safe(() =>
        reserve(
          {
            windowId: input.windowId,
            retentionSeconds: input.retentionSeconds,
            binding: {
              writerKind: "customer",
              logicalOperationId: input.ownerAccountId,
              ownerAccountId: input.ownerAccountId,
            },
            envelope: {
              bodyKind: "absent",
              bodyText: null,
              method: "POST",
              endpoint: "/v1/customers",
              target: null,
              accountScope: "platform",
              connectedAccountReference: null,
              apiVersion: "unused",
            },
          },
          input.providerReference,
        ),
      ),
    complete: (key, version, result) =>
      safe(async () => {
        if (result.state === "succeeded") {
          if (
            key.objectClass === 6 && key.operation === "create"
              ? result.providerReference !== null
              : !result.providerReference || !validProviderReference(result.providerReference)
          )
            return refused("unsafe-material");
          if (result.responseExpiresAt != null && !Number.isFinite(Date.parse(result.responseExpiresAt)))
            return refused("unsafe-material");
        }
        return update(
          key,
          version,
          "state = $6, provider_reference = $7, response_expires_at = $8",
          "state = 'pending'",
          [
            result.state,
            result.state === "succeeded" ? result.providerReference : null,
            result.state === "succeeded" ? (result.responseExpiresAt ?? null) : null,
          ],
        );
      }),
    observeCapture: (key, version) =>
      safe(() =>
        update(
          key,
          version,
          "observed_class = 1",
          "state = 'succeeded' AND object_class = 2 AND operation = 'create'",
          [],
        ),
      ),
    claimReplay: (key, version, now) =>
      safe(async () => {
        if (!Number.isFinite(Date.parse(now))) return refused("replay-expired");
        const row = await readKey(db, key);
        if (!row) return refused("unknown-write");
        if (Date.parse(now) >= Date.parse(row.replayDeadline)) return refused("replay-expired");
        if (row.state !== "pending") return refused(row.state === "failed" ? "write-failed" : "write-unresolved");
        if (row.replayAttempts === 1) {
          const changed = await update(
            key,
            version,
            "state = 'ambiguous'",
            "state = 'pending' AND replay_attempts = 1",
            [],
          );
          return changed.kind === "stale-write-rejected" ? changed : refused("write-unresolved");
        }
        return update(
          key,
          version,
          "replay_attempts = 1",
          `state = 'pending' AND replay_attempts = 0 AND replay_deadline > $6::timestamptz
         AND replay_deadline > statement_timestamp() AND EXISTS (SELECT 1 FROM evidence_window w
           WHERE w.window_id = evidence_window_provider_write.window_id AND w.state = 'open' AND w.expires_at > statement_timestamp())`,
          [now],
        );
      }),
    admitSavedResponse: (key, binding, now) =>
      safe(async () => {
        const row = await readKey(db, key);
        if (!row) return refused("unknown-write");
        if (!sameBinding(row.binding, binding)) return refused("binding-drift");
        if (
          key.objectClass !== 6 ||
          key.operation !== "create" ||
          row.state !== "succeeded" ||
          binding.usability !== "qualified-unused" ||
          !row.responseExpiresAt ||
          !Number.isFinite(Date.parse(now)) ||
          Date.parse(now) >= Date.parse(row.replayDeadline) ||
          Date.parse(now) >= Date.parse(row.responseExpiresAt)
        )
          return refused("response-unqualified");
        const authority = await db.query(
          `SELECT 1 FROM evidence_window WHERE window_id = $1 AND state = 'open'
           AND expires_at > statement_timestamp() AND $2::timestamptz > statement_timestamp()
           AND $3::timestamptz > statement_timestamp()`,
          [key.windowId, row.replayDeadline, row.responseExpiresAt],
        );
        if (authority.rows.length !== 1) return refused("response-unqualified");
        return { kind: "existing", row };
      }),
    readWindow: async (windowId) => {
      if (!/^[0-9a-f]{32}$/.test(windowId)) throw new ProviderWriteRefused("invalid-identity");
      try {
        const result = await db.query<StoredRow>(
          `SELECT * FROM evidence_window_provider_write WHERE window_id = $1
           ORDER BY object_class, creation_ordinal, operation LIMIT 647`,
          [windowId],
        );
        if (result.rows.length > 646) throw new ProviderWriteRefused("storage-failed");
        return result.rows.map(mapRow);
      } catch {
        throw new ProviderWriteRefused("storage-failed");
      }
    },
  };
}
