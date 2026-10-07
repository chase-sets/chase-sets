import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  openSecretEnvelope,
  sealSecretEnvelope,
  type SecretEnvelopeKeyring,
} from "@chase-sets/platform-runtime/secret-envelope";
import {
  CatalogOperatorSessionError,
  nextOperatorSessionRevision,
  validateOperatorSessionInstant,
  validateOperatorSessionRevision,
  validateOperatorSessionValue,
} from "../domain/value";
import {
  operatorSessionOutcomeFromRow,
  type OperatorSessionOutcomeRow,
  type OperatorSessionReadinessSnapshot,
} from "../domain/readiness";
import { lockOperatorSessionReadiness, resetOperatorSessionOutcome } from "./outcomes";

const version = "CatalogOperatorSession/v1";
const providerKey = "tcgplayer";

export type CatalogOperatorSessionMetadata = Readonly<
  | { state: "cleared"; revision: number; keyId: string }
  | {
      state: "stored";
      revision: number;
      keyId: string;
      storedAt: string;
      observedAt: string;
      browserExpiresAt: string | null;
    }
>;
export type CatalogOperatorSessionResolution = { value: string; revision: number } | { unavailable: "custody" } | null;
export type CatalogOperatorSessionStore = Readonly<{
  accept(input: {
    expectedRevision: number;
    value: string;
    observedAt: string;
    browserExpiresAt: string | null;
  }): Promise<{ outcome: "stored" | "unchanged" | "stale-revision"; revision: number }>;
  clear(input: {
    expectedRevision: number;
    expectedKeyId: string | null;
  }): Promise<{ outcome: "cleared" | "unchanged" | "stale-revision"; revision: number }>;
  readMetadata(): Promise<CatalogOperatorSessionMetadata | null>;
  resolve(): Promise<CatalogOperatorSessionResolution>;
}>;

type Row = {
  provider_key: string;
  version: string;
  state: "stored" | "cleared";
  revision: string;
  key_id: string;
  ciphertext: Buffer | null;
  iv: Buffer | null;
  tag: Buffer | null;
  stored_at: Date | string | null;
  observed_at: Date | string | null;
  browser_expires_at: Date | string | null;
};

function aad(revision: number, keyId: string): Buffer {
  return Buffer.from(JSON.stringify([providerKey, version, revision, keyId]), "utf8");
}

function open(row: Row, keyring: SecretEnvelopeKeyring | null): string | null {
  const key = keyring?.keys.get(row.key_id);
  if (!key || !row.ciphertext || !row.iv || !row.tag) return null;
  let plaintext: Buffer | undefined;
  try {
    plaintext = openSecretEnvelope(key, aad(Number(row.revision), row.key_id), {
      ciphertext: row.ciphertext,
      iv: row.iv,
      tag: row.tag,
    });
    const value = plaintext.toString("utf8");
    validateOperatorSessionValue(value);
    return value;
  } catch {
    return null;
  } finally {
    plaintext?.fill(0);
  }
}

export function createPostgresCatalogOperatorSessionStore(
  db: PgQueryable,
  keyring: SecretEnvelopeKeyring | null,
): CatalogOperatorSessionStore {
  async function query<TRow extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    try {
      return await db.query<TRow>(sql, values);
    } catch {
      throw new CatalogOperatorSessionError("custody-unavailable");
    }
  }
  async function read(): Promise<Row | undefined> {
    return (
      await query<Row>("SELECT * FROM catalog_tcgplayer_operator_sessions WHERE provider_key = $1", [providerKey])
    ).rows[0];
  }
  async function stale() {
    return { outcome: "stale-revision" as const, revision: Number((await read())?.revision ?? 0) };
  }
  return {
    async accept(input) {
      validateOperatorSessionValue(input.value);
      validateOperatorSessionInstant(input.observedAt);
      if (input.browserExpiresAt !== null) validateOperatorSessionInstant(input.browserExpiresAt);
      validateOperatorSessionRevision(input.expectedRevision);
      await lockOperatorSessionReadiness({ query });
      const row = await read();
      if (input.expectedRevision !== Number(row?.revision ?? 0)) return stale();
      const keyId = keyring?.activeKeyId;
      const key = keyId ? keyring?.keys.get(keyId) : undefined;
      if (!key || !keyId || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId))
        throw new CatalogOperatorSessionError("custody-unavailable");
      if (row?.state === "stored" && row.key_id === keyId && open(row, keyring) === input.value) {
        return { outcome: "unchanged", revision: Number(row.revision) };
      }
      const revision = nextOperatorSessionRevision(input.expectedRevision);
      const plaintext = Buffer.from(input.value, "utf8");
      let sealed;
      try {
        sealed = sealSecretEnvelope(key, aad(revision, keyId), plaintext);
      } catch {
        throw new CatalogOperatorSessionError("custody-unavailable");
      } finally {
        plaintext.fill(0);
      }
      const values = [
        providerKey,
        version,
        revision,
        keyId,
        sealed.ciphertext,
        sealed.iv,
        sealed.tag,
        input.observedAt,
        input.browserExpiresAt,
      ];
      const result = row
        ? await query(
            `UPDATE catalog_tcgplayer_operator_sessions SET state = 'stored', version = $2,
            revision = $3, key_id = $4, ciphertext = $5, iv = $6, tag = $7,
            stored_at = clock_timestamp(), observed_at = $8, browser_expires_at = $9
          WHERE provider_key = $1 AND revision = $10 AND key_id = $11 AND state = $12 RETURNING revision`,
            [...values, input.expectedRevision, row.key_id, row.state],
          )
        : await query(
            `INSERT INTO catalog_tcgplayer_operator_sessions
            (provider_key, version, state, revision, key_id, ciphertext, iv, tag, stored_at, observed_at, browser_expires_at)
          VALUES ($1, $2, 'stored', $3, $4, $5, $6, $7, clock_timestamp(), $8, $9)
          ON CONFLICT (provider_key) DO NOTHING RETURNING revision`,
            values,
          );
      if (!result.rows.length) return stale();
      await resetOperatorSessionOutcome({ query });
      return { outcome: "stored", revision };
    },
    async clear(input) {
      validateOperatorSessionRevision(input.expectedRevision);
      if (
        input.expectedRevision === 0
          ? input.expectedKeyId !== null
          : typeof input.expectedKeyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.expectedKeyId)
      ) {
        throw new CatalogOperatorSessionError("invalid-session-fence");
      }
      await lockOperatorSessionReadiness({ query });
      const row = await read();
      if (input.expectedRevision !== Number(row?.revision ?? 0) || input.expectedKeyId !== (row?.key_id ?? null))
        return stale();
      if (!row || row.state === "cleared") return { outcome: "unchanged", revision: input.expectedRevision };
      const revision = nextOperatorSessionRevision(input.expectedRevision);
      const result = await query(
        `UPDATE catalog_tcgplayer_operator_sessions SET state = 'cleared', revision = $4,
          ciphertext = NULL, iv = NULL, tag = NULL, stored_at = NULL, observed_at = NULL, browser_expires_at = NULL
        WHERE provider_key = $1 AND revision = $2 AND key_id = $3 AND state = 'stored' RETURNING revision`,
        [providerKey, input.expectedRevision, input.expectedKeyId, revision],
      );
      if (!result.rows.length) return stale();
      await resetOperatorSessionOutcome({ query });
      return { outcome: "cleared", revision };
    },
    async readMetadata() {
      const row = await read();
      if (!row) return null;
      const fence = { revision: Number(row.revision), keyId: row.key_id };
      if (row.state === "cleared") return { state: "cleared", ...fence };
      return {
        state: "stored",
        ...fence,
        storedAt: new Date(row.stored_at!).toISOString(),
        observedAt: new Date(row.observed_at!).toISOString(),
        browserExpiresAt: row.browser_expires_at === null ? null : new Date(row.browser_expires_at).toISOString(),
      };
    },
    async resolve() {
      try {
        const row = await read();
        if (!row || row.state === "cleared") return null;
        const value = open(row, keyring);
        return value === null ? { unavailable: "custody" } : { value, revision: Number(row.revision) };
      } catch {
        return { unavailable: "custody" };
      }
    },
  };
}

export async function readCatalogOperatorSessionSnapshot(
  db: PgQueryable,
  keyring: SecretEnvelopeKeyring | null,
  environmentValue: string | null,
): Promise<{ value: string | null; readiness: OperatorSessionReadinessSnapshot }> {
  try {
    const row = (
      await db.query<Row & { outcome: OperatorSessionOutcomeRow | null }>(
        `SELECT custody.*, row_to_json(outcome) AS outcome
       FROM (SELECT 'tcgplayer'::text AS provider_key) AS provider
       LEFT JOIN catalog_tcgplayer_operator_sessions AS custody ON custody.provider_key = provider.provider_key
       LEFT JOIN catalog_tcgplayer_operator_session_outcomes AS outcome ON outcome.provider_key = provider.provider_key`,
      )
    ).rows[0];
    const custody = row?.state ?? "absent";
    let value = custody === "stored" ? open(row!, keyring) : environmentValue;
    const outcome = row?.outcome ? operatorSessionOutcomeFromRow(row.outcome) : null;
    if (custody === "stored" && !value)
      return {
        value: null,
        readiness: { custody: "unavailable", identity: null, browserExpiresAt: null, outcome: null },
      };
    if (value) {
      try {
        validateOperatorSessionValue(value);
      } catch {
        value = null;
      }
    }
    const custodyRevision = Number(row?.revision ?? 0);
    return {
      value,
      readiness: {
        custody,
        identity: value
          ? {
              source: custody === "stored" ? "operator-session" : "environment",
              revision: custody === "stored" ? custodyRevision : 0,
              custodyRevision,
            }
          : null,
        browserExpiresAt: row?.browser_expires_at ? new Date(row.browser_expires_at).toISOString() : null,
        outcome,
      },
    };
  } catch {
    return {
      value: null,
      readiness: { custody: "unavailable", identity: null, browserExpiresAt: null, outcome: null },
    };
  }
}
