import { randomUUID } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  openSecretEnvelope,
  sealSecretEnvelope,
  type SecretEnvelopeBytes,
} from "../../../support/runtime-support/secret-envelope";
import { decodeTokenSet, encodeEnvelopeAad, encodeTokenSet, nextCredentialCounter } from "../domain/codecs";
import {
  ChannelCredentialError,
  type ChannelCredentialEnvelope,
  type ChannelCredentialKeyring,
} from "../domain/contracts";

export type ChannelCredentialBinding = Pick<
  ChannelCredentialEnvelope,
  "accountId" | "connectionId" | "providerKey" | "environment"
>;
export type ChannelCredentialExpectation = ChannelCredentialBinding &
  Readonly<{ reference: string; tokenGeneration: number }>;
export type ChannelCredentialCapabilityBinding = Readonly<{ capability: object; binding: ChannelCredentialBinding }>;
type Stored = ChannelCredentialEnvelope & SecretEnvelopeBytes;
const metadataColumns = `row_id AS "rowId", version, kind, provider_key AS "providerKey", environment,
  account_id AS "accountId", connection_id AS "connectionId", payload_format AS "payloadFormat",
  token_generation::float8 AS "tokenGeneration", envelope_revision::float8 AS "envelopeRevision",
  key_id AS "keyId", created_at AS "createdAt", updated_at AS "updatedAt"`;
const columns = `${metadataColumns}, iv, ciphertext, tag`;

function metadata(row: ChannelCredentialEnvelope & Partial<SecretEnvelopeBytes>): ChannelCredentialEnvelope {
  const { iv: _iv, ciphertext: _ciphertext, tag: _tag, ...result } = row;
  encodeEnvelopeAad(result);
  return result;
}

function sameBinding(left: ChannelCredentialBinding, right: ChannelCredentialBinding): boolean {
  return (
    left.accountId === right.accountId &&
    left.connectionId === right.connectionId &&
    left.providerKey === right.providerKey &&
    left.environment === right.environment
  );
}

async function query<Row>(db: PgQueryable, sql: string, values: readonly unknown[] = []) {
  try {
    return await db.query<Row>(sql, values);
  } catch {
    throw new ChannelCredentialError("storage-unavailable");
  }
}

export function createChannelCredentialRuntime(
  configured: ChannelCredentialKeyring | null = null,
  bindings: readonly ChannelCredentialCapabilityBinding[] = [],
) {
  // Snapshot injected authority: later mutation of configuration or binding objects cannot widen access.
  const keys = new Map([...(configured?.keys ?? [])].map(([id, key]) => [id, Buffer.from(key)]));
  const activeKeyId = configured?.activeKeyId;
  const capabilities = new Map(bindings.map(({ capability, binding }) => [capability, { ...binding }]));
  function active() {
    const key = activeKeyId === undefined ? undefined : keys.get(activeKeyId);
    if (!key || activeKeyId === undefined) throw new ChannelCredentialError("unavailable");
    return { key, keyId: activeKeyId };
  }
  function decrypt(row: Stored): Buffer {
    try {
      const key = keys.get(row.keyId);
      if (!key || row.ciphertext.length < 1 || row.ciphertext.length > 32768) throw new Error();
      const bytes = openSecretEnvelope(key, encodeEnvelopeAad(metadata(row)), row);
      try {
        decodeTokenSet(bytes);
        return bytes;
      } catch {
        bytes.fill(0);
        throw new Error();
      }
    } catch {
      throw new ChannelCredentialError("unavailable");
    }
  }
  async function read(db: PgQueryable, reference: string) {
    return (
      await query<Stored>(db, `SELECT ${columns} FROM channels_connection_credentials WHERE row_id = $1`, [reference])
    ).rows[0];
  }
  async function current(db: PgQueryable, expected: ChannelCredentialEnvelope) {
    active();
    encodeEnvelopeAad(expected);
    const row = await read(db, expected.rowId);
    if (!row || !encodeEnvelopeAad(metadata(row)).equals(encodeEnvelopeAad(expected)))
      throw new ChannelCredentialError("conflict");
    return row;
  }
  async function rewrite(
    db: PgQueryable,
    before: ChannelCredentialEnvelope,
    after: ChannelCredentialEnvelope,
    bytes: Uint8Array,
  ) {
    const sealed = sealSecretEnvelope(active().key, encodeEnvelopeAad(after), bytes);
    const result = await query(
      db,
      `UPDATE channels_connection_credentials
      SET token_generation = $1, envelope_revision = $2, key_id = $3, iv = $4, ciphertext = $5, tag = $6, updated_at = $7
      WHERE row_id = $8 AND token_generation = $9 AND envelope_revision = $10
        AND version = $11 AND kind = $12 AND provider_key = $13 AND environment = $14
        AND account_id = $15 AND connection_id = $16 AND payload_format = $17 AND created_at = $18
      RETURNING row_id`,
      [
        after.tokenGeneration,
        after.envelopeRevision,
        after.keyId,
        sealed.iv,
        sealed.ciphertext,
        sealed.tag,
        after.updatedAt,
        before.rowId,
        before.tokenGeneration,
        before.envelopeRevision,
        before.version,
        before.kind,
        before.providerKey,
        before.environment,
        before.accountId,
        before.connectionId,
        before.payloadFormat,
        before.createdAt,
      ],
    );
    if (result.rows.length !== 1) throw new ChannelCredentialError("conflict");
    return after;
  }
  return {
    async create(
      db: PgQueryable,
      binding: ChannelCredentialBinding,
      payload: unknown,
      at: string,
    ): Promise<ChannelCredentialEnvelope> {
      const { key, keyId } = active();
      const bytes = encodeTokenSet(payload);
      try {
        const row: ChannelCredentialEnvelope = {
          version: "ChannelCredentialEnvelope/v1",
          rowId: `credential-${randomUUID()}`,
          kind: "oauth-token-set",
          providerKey: binding.providerKey,
          environment: binding.environment,
          accountId: binding.accountId,
          connectionId: binding.connectionId,
          payloadFormat: "ChannelOAuthTokenSet/v1",
          tokenGeneration: 1,
          envelopeRevision: 1,
          keyId,
          createdAt: at,
          updatedAt: at,
        };
        const sealed = sealSecretEnvelope(key, encodeEnvelopeAad(row), bytes);
        const result = await query(
          db,
          `INSERT INTO channels_connection_credentials
          (row_id,version,kind,provider_key,environment,account_id,connection_id,payload_format,token_generation,envelope_revision,key_id,created_at,updated_at,iv,ciphertext,tag)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (row_id) DO NOTHING RETURNING row_id`,
          [
            row.rowId,
            row.version,
            row.kind,
            row.providerKey,
            row.environment,
            row.accountId,
            row.connectionId,
            row.payloadFormat,
            row.tokenGeneration,
            row.envelopeRevision,
            row.keyId,
            row.createdAt,
            row.updatedAt,
            sealed.iv,
            sealed.ciphertext,
            sealed.tag,
          ],
        );
        if (result.rows.length !== 1) throw new ChannelCredentialError("conflict");
        return row;
      } finally {
        bytes.fill(0);
      }
    },
    async replace(
      db: PgQueryable,
      expected: ChannelCredentialEnvelope,
      payload: unknown,
      at: string,
    ): Promise<ChannelCredentialEnvelope> {
      const row = await current(db, expected);
      const bytes = encodeTokenSet(payload);
      let beforeBytes: Buffer | undefined;
      try {
        beforeBytes = decrypt(row);
        if (bytes.equals(beforeBytes)) return metadata(row);
        const beforeTokens = decodeTokenSet(beforeBytes),
          afterTokens = decodeTokenSet(bytes);
        const materialChanged =
          beforeTokens.accessToken !== afterTokens.accessToken ||
          beforeTokens.refresh.kind !== afterTokens.refresh.kind ||
          (beforeTokens.refresh.kind === "present" &&
            afterTokens.refresh.kind === "present" &&
            beforeTokens.refresh.token !== afterTokens.refresh.token);
        const after = {
          ...expected,
          tokenGeneration: materialChanged ? nextCredentialCounter(expected.tokenGeneration) : expected.tokenGeneration,
          envelopeRevision: nextCredentialCounter(expected.envelopeRevision),
          keyId: active().keyId,
          updatedAt: at,
        };
        return await rewrite(db, expected, after, bytes);
      } finally {
        bytes.fill(0);
        beforeBytes?.fill(0);
      }
    },
    async rewrap(db: PgQueryable, expected: ChannelCredentialEnvelope, at: string): Promise<ChannelCredentialEnvelope> {
      const row = await current(db, expected);
      const bytes = decrypt(row);
      try {
        if (row.keyId === active().keyId) return metadata(row);
        return await rewrite(
          db,
          expected,
          {
            ...expected,
            envelopeRevision: nextCredentialCounter(expected.envelopeRevision),
            keyId: active().keyId,
            updatedAt: at,
          },
          bytes,
        );
      } finally {
        bytes.fill(0);
      }
    },
    async resolve(db: PgQueryable, capability: object, expected: ChannelCredentialExpectation): Promise<Buffer> {
      const binding = capabilities.get(capability);
      if (!binding || !sameBinding(binding, expected)) throw new ChannelCredentialError("forbidden");
      active();
      const row = await read(db, expected.reference);
      if (
        !row ||
        !sameBinding(row, expected) ||
        row.rowId !== expected.reference ||
        row.tokenGeneration !== expected.tokenGeneration
      )
        throw new ChannelCredentialError("forbidden");
      return decrypt(row);
    },
    async readMetadata(db: PgQueryable, reference: string): Promise<ChannelCredentialEnvelope | null> {
      const row = (
        await query<ChannelCredentialEnvelope>(
          db,
          `SELECT ${metadataColumns} FROM channels_connection_credentials WHERE row_id = $1`,
          [reference],
        )
      ).rows[0];
      return row ? metadata(row) : null;
    },
    async rotationPage(
      db: PgQueryable,
      keyId: string,
      afterRowId: string | null = null,
      limit = 100,
    ): Promise<readonly ChannelCredentialEnvelope[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ChannelCredentialError("invalid-envelope");
      const rows = await query<ChannelCredentialEnvelope>(
        db,
        `SELECT ${metadataColumns} FROM channels_connection_credentials WHERE key_id = $1 AND row_id > $2 ORDER BY row_id LIMIT $3`,
        [keyId, afterRowId ?? "", limit],
      );
      return rows.rows.map(metadata);
    },
    async retirementPreflight(
      db: PgQueryable,
      keyId: string,
      oldKeyWritersDrained: boolean,
    ): Promise<"writers-not-drained" | "active-key" | "referenced" | "zero-references"> {
      if (oldKeyWritersDrained !== true) return "writers-not-drained";
      if (keyId === active().keyId) return "active-key";
      const result = await query<{ referenced: boolean }>(
        db,
        "SELECT EXISTS (SELECT 1 FROM channels_connection_credentials WHERE key_id = $1) AS referenced",
        [keyId],
      );
      return result.rows[0].referenced ? "referenced" : "zero-references";
    },
  };
}

export type ChannelCredentialServices = ReturnType<typeof createChannelCredentialRuntime>;
