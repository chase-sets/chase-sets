import { createHash, randomUUID } from "node:crypto";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { ConfigurationEpochError } from "@chase-sets/event-core/configuration-epoch";
import type { AppendToStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import {
  createPostgresConfigurationEpochStore,
  withConfigurationEpochTransaction,
  isPgRetryableTransientError,
  type PgPoolClient,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import {
  configurationRevision,
  parseRepricingConfigurationReceipt,
  parseRepricingConfigurationStatus,
  type RepricingConfigurationReceipt,
  type RepricingConfigurationStatus,
} from "../domain/configuration-receipt";
import { parseRepricingPolicyState, parseRepricingHaltState } from "../domain/configuration-state";
import type { RepricingPolicyState } from "../domain/domain";
import type { RepricingHaltState } from "../domain/halt";
import { canonicalJson } from "../../repricing-engine/api/dry-run";

export class RepricingConfigurationConflict extends Error {
  readonly code = "concurrency_conflict";
}

export type PreparedRepricingConfiguration<State> = Readonly<{ append: AppendToStreamInput; state: State }>;
type InstallationGuard = Readonly<{
  key: string;
  allowsInstallation: (client: PgPoolClient) => Promise<boolean>;
}>;
type RepricingConfigurationRequest<State> = Readonly<{
  key: string;
  accountId: string;
  requestKey?: string;
  fingerprint: string;
  parseState: (value: unknown) => State;
  prepare: (client: PgPoolClient) => Promise<PreparedRepricingConfiguration<State> | null>;
  installationGuard?: InstallationGuard | undefined;
}>;
export type RepricingConfigurationWriter = Readonly<{
  request: <State>(input: RepricingConfigurationRequest<State>) => Promise<RepricingConfigurationReceipt<State> | null>;
  status: <State>(key: string, parseState: (value: unknown) => State) => Promise<RepricingConfigurationStatus<State>>;
  retry: <State>(
    key: string,
    accountId: string,
    requestKey: string,
    fingerprint: string,
    parseState: (value: unknown) => State,
    installationGuard?: InstallationGuard,
  ) => Promise<RepricingConfigurationReceipt<State> | null>;
  list: (
    accountId: string,
  ) => Promise<readonly RepricingConfigurationReceipt<RepricingPolicyState | RepricingHaltState>[]>;
}>;

const sourceIncarnation = "pricing-repricing-configuration-v1";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const isRetryableParticipationFailure = (error: unknown) =>
  isPgRetryableTransientError(error) ||
  (error instanceof ConfigurationEpochError &&
    /^Configuration epoch: participation (connection|query) timed out; closure remains pending$/.test(error.message));
type RequestRow = Readonly<{
  key: string;
  requested_revision: number;
  request_key: string;
  fingerprint: string;
  prepared: string;
  prepared_hash: string;
  receipt: unknown;
  committed_events: readonly StoredEvent[];
}>;
type Head = Readonly<{ creation_revision: number; requested_revision: number; installed_revision: number }>;

export const repricingPolicyConfigurationKey = (accountId: string, policyId: string) =>
  `pricing.repricing-policy:${accountId}:${policyId}`;
export const repricingHaltConfigurationKey = (accountId: string) => `pricing.repricing-halt:${accountId}`;

export function createRepricingConfigurationEpochStore(
  deps: Pick<Parameters<typeof createPostgresConfigurationEpochStore>[0], "pool" | "consumers">,
) {
  return createPostgresConfigurationEpochStore({
    ...deps,
    sourceIncarnation,
    readCanonicalCreation: async (client, key) => {
      const result = await client.query<{
        requested_revision: number;
        creation_revision: number;
        has_history: boolean;
      }>(
        `SELECT requested_revision, creation_revision,
          EXISTS (SELECT 1 FROM event_configuration_journal_heads WHERE role = 'source' AND key = $1) AS has_history
         FROM pricing_repricing_configuration_heads WHERE key = $1`,
        [key],
      );
      const owner = result.rows[0];
      if (!owner) return undefined;
      if (owner.requested_revision !== owner.creation_revision && !owner.has_history)
        throw new ConfigurationEpochError("partial Pricing configuration source history");
      return { kind: "CREATED", sourceIncarnation, keyCreationEpoch: 0 };
    },
  });
}

export function createRepricingConfigurationWriter(
  deps: Readonly<{
    pool: PgTransactionalPool;
    eventStore: Pick<PostgresEventStore, "appendToStreamInTransaction">;
    epochs?: Pick<
      ReturnType<typeof createPostgresConfigurationEpochStore>,
      "beginClosureInTransaction" | "installClosureInTransaction" | "driveClosure"
    >;
  }>,
): RepricingConfigurationWriter {
  const epochs =
    deps.epochs ??
    createRepricingConfigurationEpochStore({
      pool: deps.pool,
      consumers: [],
    });
  const transaction = <T>(work: (client: PgPoolClient) => Promise<T>) =>
    withConfigurationEpochTransaction(deps.pool, work);
  async function lock(client: PgQueryable, key: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pricing_configuration:' || $1::text, 0))", [
      key,
    ]);
  }
  async function head(client: PgQueryable, key: string): Promise<Head | undefined> {
    const result = await client.query<Head>(
      "SELECT requested_revision, installed_revision, creation_revision FROM pricing_repricing_configuration_heads WHERE key = $1",
      [key],
    );
    const value = result.rows[0];
    if (
      value &&
      (!configurationRevision(value.requested_revision) ||
        !configurationRevision(value.installed_revision) ||
        !configurationRevision(value.creation_revision) ||
        value.creation_revision > value.installed_revision ||
        value.installed_revision > value.requested_revision)
    )
      throw new Error("Corrupt Pricing configuration head.");
    if (value) {
      const history = (
        await client.query<{ count: string; first: number | null; last: number | null }>(
          `SELECT count(*)::text AS count, min(requested_revision) AS first, max(requested_revision) AS last
         FROM pricing_repricing_configuration_requests WHERE key = $1`,
          [key],
        )
      ).rows[0];
      const length = value.requested_revision - value.creation_revision;
      if (
        !history ||
        Number(history.count) !== length ||
        (length > 0 && (history.first !== value.creation_revision + 1 || history.last !== value.requested_revision))
      )
        throw new Error("Partial Pricing configuration history.");
    }
    return value;
  }
  async function requestRow(client: PgQueryable, key: string, requestKey: string) {
    return (
      await client.query<RequestRow>(
        "SELECT key, requested_revision, request_key, fingerprint, prepared, prepared_hash, receipt, committed_events FROM pricing_repricing_configuration_requests WHERE key = $1 AND request_key = $2",
        [key, requestKey],
      )
    ).rows[0];
  }
  function receipt<State>(row: RequestRow, verifiedHead: Head, parseState: (value: unknown) => State) {
    if (hash(row.prepared) !== row.prepared_hash) throw new Error("Corrupt Pricing configuration request.");
    const value = parseRepricingConfigurationReceipt(row.receipt, parseState);
    if (value.requestKey !== row.request_key || value.requestedRevision !== row.requested_revision)
      throw new Error("Corrupt Pricing configuration receipt binding.");
    // The verified contiguous history and the primary key (key, requested_revision) bind the replacement.
    if (value.status === "superseded-by-revision" && value.replacingRevision > verifiedHead.requested_revision)
      throw new Error("Corrupt Pricing configuration supersession.");
    if (value.status === "applied") {
      const prepared: PreparedRepricingConfiguration<unknown> = JSON.parse(row.prepared);
      if (canonicalJson(value.state) !== canonicalJson(parseState(prepared.state)))
        throw new Error("Corrupt installed Pricing configuration value.");
    }
    return value;
  }
  return {
    async list(accountId) {
      const result = await deps.pool.query<{ key: string }>(
        `SELECT key FROM pricing_repricing_configuration_heads
         WHERE seller_account_id = $1 AND installed_revision < requested_revision ORDER BY key LIMIT 100`,
        [accountId],
      );
      const requests = [];
      for (const row of result.rows) {
        const status = await this.status<RepricingPolicyState | RepricingHaltState>(
          row.key,
          row.key.startsWith("pricing.repricing-halt:") ? parseRepricingHaltState : parseRepricingPolicyState,
        );
        if (!status.request) throw new Error("Partial Pricing configuration history.");
        requests.push(status.request);
      }
      return requests;
    },
    async retry<State>(
      key: string,
      accountId: string,
      requestKey: string,
      fingerprint: string,
      parseState: (value: unknown) => State,
      installationGuard?: InstallationGuard,
    ) {
      return this.request({
        key,
        accountId,
        requestKey,
        fingerprint,
        parseState,
        installationGuard,
        prepare: async () => null,
      });
    },
    async request<State>(input: RepricingConfigurationRequest<State>) {
      const requestKey = input.requestKey ?? randomUUID();
      if (!requestKey.length || requestKey.length > 200)
        throw new RepricingConfigurationConflict("Invalid request key.");
      const recorded = await transaction(async (client) => {
        await lock(client, `${input.accountId}:request:${requestKey}`);
        await lock(client, input.key);
        const original = (
          await client.query<RequestRow>(
            "SELECT key, requested_revision, request_key, fingerprint, prepared, prepared_hash, receipt, committed_events FROM pricing_repricing_configuration_requests WHERE seller_account_id = $1 AND request_key = $2",
            [input.accountId, requestKey],
          )
        ).rows[0];
        if (original) {
          if (original.key !== input.key || original.fingerprint !== input.fingerprint)
            throw new RepricingConfigurationConflict("Request key already used for another command.");
          const currentHead = await head(client, input.key);
          if (!currentHead) throw new Error("Partial Pricing configuration history.");
          const current = receipt(original, currentHead, input.parseState);
          return { receipt: current, events: current.status === "applied" ? original.committed_events : [] };
        }
        const prepared = await input.prepare(client);
        if (!prepared) return null;
        await client.query(
          "INSERT INTO pricing_repricing_configuration_heads (key, seller_account_id, creation_revision, requested_revision, installed_revision) VALUES ($1, $2, $3, $3, $3) ON CONFLICT DO NOTHING",
          [
            input.key,
            input.accountId,
            typeof prepared.append.expectedVersion === "number" ? prepared.append.expectedVersion : 0,
          ],
        );
        const prior = (await head(client, input.key))!;
        if (prior.requested_revision > prior.creation_revision) {
          const latest = (
            await client.query<RequestRow>(
              "SELECT key, requested_revision, request_key, fingerprint, prepared, prepared_hash, receipt FROM pricing_repricing_configuration_requests WHERE key = $1 AND requested_revision = $2",
              [input.key, prior.requested_revision],
            )
          ).rows[0];
          if (!latest) throw new Error("Partial Pricing configuration history.");
          parseRepricingConfigurationStatus(
            {
              installedRevision: prior.installed_revision,
              installedState: null,
              requestedRevision: prior.requested_revision,
              request: receipt(latest, prior, input.parseState),
            },
            input.parseState,
          );
        }
        const requestedRevision = prior.requested_revision + 1;
        if (!configurationRevision(requestedRevision)) throw new Error("Pricing configuration revision exhausted.");
        await epochs.beginClosureInTransaction(client, input.key);
        const pending: RepricingConfigurationReceipt<State> = {
          requestKey,
          requestedRevision,
          status: "accepted-pending",
        };
        const encoded = JSON.stringify(prepared);
        await client.query(
          `UPDATE pricing_repricing_configuration_requests SET receipt = jsonb_build_object('requestKey', request_key,
            'requestedRevision', requested_revision, 'status', 'superseded-by-revision', 'replacingRevision', $2::integer)
           WHERE key = $1 AND receipt->>'status' = 'accepted-pending'`,
          [input.key, requestedRevision],
        );
        await client.query(
          `INSERT INTO pricing_repricing_configuration_requests
           (key, requested_revision, request_key, fingerprint, prepared, prepared_hash, receipt, seller_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [
            input.key,
            requestedRevision,
            requestKey,
            input.fingerprint,
            encoded,
            hash(encoded),
            JSON.stringify(pending),
            input.accountId,
          ],
        );
        await client.query("UPDATE pricing_repricing_configuration_heads SET requested_revision = $2 WHERE key = $1", [
          input.key,
          requestedRevision,
        ]);
        return { receipt: pending, events: [] };
      });
      if (!recorded) return null;
      recordCommittedEvents(recorded.events, "pricing");
      const accepted = recorded.receipt;
      if (!accepted || accepted.status !== "accepted-pending") return accepted;
      const recoverPending = async (error: unknown, closureMayHaveEnded = false) => {
        const retryable = isRetryableParticipationFailure(error);
        if (!retryable && !closureMayHaveEnded) throw error;
        const outcome = await transaction(async (client) => {
          await lock(client, input.key);
          const currentHead = await head(client, input.key);
          const row = await requestRow(client, input.key, requestKey);
          if (!currentHead || !row) throw new Error("Partial Pricing configuration history.");
          const outcome = receipt(row, currentHead, input.parseState);
          return { receipt: outcome, events: outcome.status === "applied" ? row.committed_events : [] };
        }).catch((recheckError) => {
          if (isRetryableParticipationFailure(recheckError)) return { receipt: accepted, events: [] };
          throw recheckError;
        });
        if (outcome.receipt.status === "accepted-pending" && !retryable) throw error;
        return outcome;
      };
      try {
        const closure = await epochs.driveClosure(input.key);
        if (closure.pendingConsumers.length) return accepted;
      } catch (error) {
        const outcome = await recoverPending(
          error,
          error instanceof ConfigurationEpochError && error.message === "Configuration epoch: not CLOSING",
        );
        recordCommittedEvents(outcome.events, "pricing");
        return outcome.receipt;
      }
      const installed = await transaction(async (client) => {
        await lock(client, input.key);
        const currentHead = await head(client, input.key);
        const original = await requestRow(client, input.key, requestKey);
        if (!currentHead || !original) throw new Error("Partial Pricing configuration history.");
        const current = receipt(original, currentHead, input.parseState);
        if (current.status !== "accepted-pending")
          return { receipt: current, events: current.status === "applied" ? original.committed_events : [] };
        if (currentHead.requested_revision !== current.requestedRevision)
          throw new Error("Partial Pricing configuration history.");
        const prepared: PreparedRepricingConfiguration<unknown> = JSON.parse(original.prepared);
        const state = input.parseState(prepared.state);
        if (input.installationGuard) {
          await lock(client, input.installationGuard.key);
          if (!(await input.installationGuard.allowsInstallation(client))) return { receipt: current, events: [] };
        }
        await epochs.installClosureInTransaction(client, input.key);
        const events = await deps.eventStore.appendToStreamInTransaction(client, prepared.append);
        const applied: RepricingConfigurationReceipt<State> = {
          ...current,
          status: "applied",
          installedRevision: current.requestedRevision,
          state,
        };
        await client.query(
          "UPDATE pricing_repricing_configuration_requests SET receipt = $3::jsonb, committed_events = $4::jsonb WHERE key = $1 AND request_key = $2",
          [input.key, requestKey, JSON.stringify(applied), JSON.stringify(events)],
        );
        await client.query("UPDATE pricing_repricing_configuration_heads SET installed_revision = $2 WHERE key = $1", [
          input.key,
          current.requestedRevision,
        ]);
        return { receipt: applied, events };
      }).catch(recoverPending);
      recordCommittedEvents(installed.events, "pricing");
      return installed.receipt;
    },
    async status<State>(key: string, parseState: (value: unknown) => State) {
      return transaction(async (client) => {
        await lock(client, key);
        const current = await head(client, key);
        if (!current) return { installedRevision: 0, installedState: null, requestedRevision: 0, request: null };
        const rows = await client.query<RequestRow>(
          "SELECT key, requested_revision, request_key, fingerprint, prepared, prepared_hash, receipt FROM pricing_repricing_configuration_requests WHERE key = $1 AND requested_revision = $2",
          [key, current.requested_revision],
        );
        const row = rows.rows[0];
        if (!row) throw new Error("Partial Pricing configuration history.");
        let installedState: State | null = null;
        if (current.installed_revision > current.creation_revision) {
          const installedRow = (
            await client.query<RequestRow>(
              "SELECT key, requested_revision, request_key, fingerprint, prepared, prepared_hash, receipt FROM pricing_repricing_configuration_requests WHERE key = $1 AND requested_revision = $2",
              [key, current.installed_revision],
            )
          ).rows[0];
          if (!installedRow) throw new Error("Partial Pricing configuration history.");
          const installed = receipt(installedRow, current, parseState);
          if (installed.status !== "applied") throw new Error("Corrupt installed Pricing configuration receipt.");
          installedState = installed.state;
        }
        return parseRepricingConfigurationStatus(
          {
            installedRevision: current.installed_revision,
            installedState,
            requestedRevision: current.requested_revision,
            request: receipt(row, current, parseState),
          },
          parseState,
        );
      });
    },
  };
}
