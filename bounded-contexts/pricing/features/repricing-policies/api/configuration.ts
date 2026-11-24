import { createHash, randomUUID } from "node:crypto";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { ConfigurationEpochError } from "@chase-sets/event-core/configuration-epoch";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { AppendToStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import {
  createPostgresConfigurationEpochStore,
  enrollOwnerPredicateWriteInTransaction,
  ownerPredicateKey,
  withConfigurationEpochTransaction,
  withOwnerPredicateWrite,
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
import {
  evolveRepricingPolicy,
  initialRepricingPolicyState,
  type RepricingPolicyState,
  type RepricingPolicyEvent,
} from "../domain/domain";
import {
  evolveRepricingHalt,
  initialRepricingHaltState,
  repricingHaltStreamId,
  type RepricingHaltState,
  type RepricingHaltEvent,
} from "../domain/halt";
import { repricingPolicyStreamId } from "../read-model/projection";
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
  captureAccount: (
    client: PgQueryable,
    accountId: string,
    role: "installed" | "competitor",
  ) => Promise<
    Readonly<{
      policies: readonly Readonly<{ state: RepricingPolicyState; version: number }>[];
      halt: Readonly<{ state: RepricingHaltState; version: number }>;
    }>
  >;
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
export const repricingStandingKey = (accountId: string) => `repricing-account/${accountId}`;

export function createRepricingStandingEpochStore(
  deps: Pick<Parameters<typeof createPostgresConfigurationEpochStore>[0], "pool" | "consumers" | "sourceIncarnation">,
) {
  return createPostgresConfigurationEpochStore({
    ...deps,
    readCanonicalCreation: async (client, key) => {
      const standing = await client.query<{ incarnation: string; epoch: number; has_history: boolean }>(
        `SELECT incarnation, epoch, EXISTS (SELECT 1 FROM event_configuration_journal_heads WHERE role = 'source' AND key = $1) AS has_history
         FROM pricing_repricing_standing WHERE key = $1`,
        [key],
      );
      const row = standing.rows[0];
      if (!row || row.incarnation !== deps.sourceIncarnation) return undefined;
      if (row.epoch !== 0 && !row.has_history)
        throw new ConfigurationEpochError("partial Pricing standing source history");
      return { kind: "CREATED", sourceIncarnation: row.incarnation, keyCreationEpoch: 0 };
    },
  });
}

type StandingEpochs = ReturnType<typeof createRepricingStandingEpochStore>;
export type RepricingStanding = Readonly<{
  source: () => Promise<{ incarnation: string; epochs: StandingEpochs }>;
}>;

/** Establish a single account creation boundary before the first account closure. */
export async function lockRepricingStanding(client: PgQueryable, key: string, incarnation: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('configuration_epoch:' || $1::text, 0))", [key]);
  await client.query(
    "INSERT INTO pricing_repricing_standing (key, incarnation, epoch) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING",
    [key, incarnation],
  );
  const row = (
    await client.query<{ incarnation: string; epoch: number }>(
      "SELECT incarnation, epoch FROM pricing_repricing_standing WHERE key = $1",
      [key],
    )
  ).rows[0];
  if (!row || row.incarnation !== incarnation) throw new ConfigurationEpochError("foreign Pricing standing");
  return row.epoch;
}

export async function restoreClosedRepricingStanding(
  pool: PgTransactionalPool,
  key: string,
  source: Awaited<ReturnType<RepricingStanding["source"]>>,
  closing: { epoch: number; topologyRevision: number },
) {
  await withConfigurationEpochTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('configuration_epoch:' || $1::text, 0))", [key]);
    const standing = await db.query<{ epoch: number }>(
      "SELECT epoch FROM pricing_repricing_standing WHERE key = $1 AND incarnation = $2 FOR UPDATE",
      [key, source.incarnation],
    );
    if (standing.rows[0]?.epoch !== closing.epoch) return;
    const installed = await source.epochs.installClosureInTransaction(db, key, closing);
    const updated = await db.query(
      "UPDATE pricing_repricing_standing SET epoch = $4 WHERE key = $1 AND incarnation = $2 AND epoch = $3",
      [key, source.incarnation, closing.epoch, installed.epoch],
    );
    if (updated.rowCount !== 1) throw new ConfigurationEpochError("Pricing standing repair lost its fence");
  });
}

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
    eventStore: Pick<PostgresEventStore, "appendToStreamInTransaction"> &
      Partial<Pick<PostgresEventStore, "readStreamInTransaction">>;
    pricingPredicateConsumerPool?: PgTransactionalPool | undefined;
    standing?: RepricingStanding | undefined;
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
  const write = <T>(work: (client: PgPoolClient) => Promise<T>) =>
    withOwnerPredicateWrite(deps.pool, deps.pricingPredicateConsumerPool, work);
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
    if (
      value.status === "superseded-by-revision" &&
      (value.replacingRevision !== row.requested_revision + 1 ||
        value.replacingRevision > verifiedHead.requested_revision)
    )
      throw new Error("Corrupt Pricing configuration supersession.");
    if (value.status === "applied") {
      const prepared: PreparedRepricingConfiguration<unknown> = JSON.parse(row.prepared);
      if (canonicalJson(value.state) !== canonicalJson(parseState(prepared.state)))
        throw new Error("Corrupt installed Pricing configuration value.");
    }
    return value;
  }
  async function captureAccount(client: PgQueryable, accountId: string, role: "installed" | "competitor") {
    const origins = await client.query<{ stream_id: string }>(
      `SELECT stream_id FROM event_store_events WHERE event_type = 'pricing.repricing-policy.created'
         AND payload->>'accountId' = $1 ORDER BY stream_id LIMIT 1001`,
      [accountId],
    );
    const heads = await client.query<{ key: string }>(
      `SELECT key FROM pricing_repricing_configuration_heads WHERE seller_account_id = $1 ORDER BY key LIMIT 1001`,
      [accountId],
    );
    if (origins.rows.length > 1000 || heads.rows.length > 1000)
      throw new Error("Pricing account authority is too large to capture.");
    const policyCodec = createPassthroughDomainEventCodec<RepricingPolicyEvent>();
    const haltCodec = createPassthroughDomainEventCodec<RepricingHaltEvent>();
    const store = {
      readStream: (input: Parameters<PostgresEventStore["readStream"]>[0]) => {
        if (!deps.eventStore.readStreamInTransaction) throw new Error("Pricing policy history is unavailable.");
        return deps.eventStore.readStreamInTransaction(client, input);
      },
    };
    const policies = new Map<string, { state: RepricingPolicyState; version: number }>();
    const installedKeys = new Map<string, RepricingPolicyState | RepricingHaltState>();
    const installedProofs = new Set<string>();
    for (const { stream_id } of origins.rows) {
      const events = await readCompleteStream(store, { streamId: stream_id, maxEvents: 10000 });
      const state = parseRepricingPolicyState(
        events.reduce(
          (prior, event) => evolveRepricingPolicy(prior, policyCodec.decode(event)),
          initialRepricingPolicyState,
        ),
      );
      if (!state.policyId || state.accountId !== accountId || repricingPolicyStreamId(state.policyId) !== stream_id)
        throw new Error("Foreign Pricing policy history.");
      policies.set(state.policyId, { state, version: events.length });
      installedKeys.set(repricingPolicyConfigurationKey(accountId, state.policyId), state);
    }
    const haltKey = repricingHaltConfigurationKey(accountId);
    const haltEvents = await readCompleteStream(store, {
      streamId: repricingHaltStreamId(accountId),
      maxEvents: 10000,
    });
    let halt = {
      state: parseRepricingHaltState(
        haltEvents.reduce(
          (prior, event) => evolveRepricingHalt(prior, haltCodec.decode(event)),
          initialRepricingHaltState,
        ),
      ),
      version: haltEvents.length,
    };
    installedKeys.set(haltKey, halt.state);
    for (const { key } of heads.rows) {
      const current = await head(client, key);
      if (!current) throw new Error("Missing Pricing configuration head.");
      const pending = current.installed_revision !== current.requested_revision;
      if (pending && role === "installed") throw new Error("Pricing standing is closing.");
      if (current.requested_revision === current.creation_revision) throw new Error("Missing Pricing request history.");
      const revision = role === "competitor" ? current.requested_revision : current.installed_revision;
      const row = (
        await client.query<RequestRow>(
          `SELECT key, requested_revision, request_key, fingerprint, prepared, prepared_hash, receipt, committed_events
           FROM pricing_repricing_configuration_requests WHERE seller_account_id = $1 AND key = $2 AND requested_revision = $3`,
          [accountId, key, revision],
        )
      ).rows[0];
      if (!row) throw new Error("Missing Pricing configuration receipt.");
      if (key === haltKey) {
        const value = receipt(row, current, parseRepricingHaltState);
        if (value.status === "applied" && canonicalJson(value.state) !== canonicalJson(halt.state))
          throw new Error("Installed halt receipt disagrees with its stream.");
        if (value.status === "applied") installedProofs.add(haltKey);
        if (pending && value.status === "accepted-pending")
          halt = { state: parseRepricingHaltState(JSON.parse(row.prepared).state), version: revision };
        else if (value.status !== "applied") throw new Error("Invalid Pricing halt receipt.");
      } else {
        const value = receipt(row, current, parseRepricingPolicyState);
        const state =
          value.status === "applied" ? value.state : parseRepricingPolicyState(JSON.parse(row.prepared).state);
        if (
          !state.policyId ||
          state.accountId !== accountId ||
          (key !== repricingPolicyConfigurationKey(accountId, state.policyId) &&
            !key.startsWith(`pricing.repricing-activation:${accountId}:`))
        )
          throw new Error("Foreign Pricing configuration receipt.");
        if (value.status === "applied") {
          const policyKey = repricingPolicyConfigurationKey(accountId, state.policyId);
          const baseline = installedKeys.get(policyKey);
          // The original activation receipt remains valid after a later revision.
          if (
            !baseline ||
            (!key.startsWith("pricing.repricing-activation:") && canonicalJson(baseline) !== canonicalJson(value.state))
          )
            throw new Error("Installed policy receipt disagrees with its stream.");
          if (canonicalJson(baseline) === canonicalJson(value.state)) installedProofs.add(policyKey);
        } else if (pending && value.status === "accepted-pending") {
          policies.set(state.policyId, { state, version: revision });
        } else throw new Error("Invalid Pricing policy receipt.");
      }
    }
    if (
      role === "installed" &&
      [...installedKeys.keys()].some((key) => (key !== haltKey || halt.version > 0) && !installedProofs.has(key))
    )
      throw new Error("Pricing configuration has no installed receipt.");
    return { policies: [...policies.values()], halt };
  }
  return {
    captureAccount,
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
      const accountPredicate = [ownerPredicateKey("repricing-account", input.accountId)];
      const accountKey = repricingStandingKey(input.accountId);
      const standing = await deps.standing?.source();
      const recorded = await write(async (client) => {
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
        await enrollOwnerPredicateWriteInTransaction(client, accountPredicate);
        if (standing) {
          await lockRepricingStanding(client, accountKey, standing.incarnation);
          await standing.epochs.beginClosureInTransaction(client, accountKey);
        }
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
        if (standing && (await standing.epochs.driveClosure(accountKey)).pendingConsumers.length) return accepted;
      } catch (error) {
        const outcome = await recoverPending(
          error,
          error instanceof ConfigurationEpochError && error.message === "Configuration epoch: not CLOSING",
        );
        recordCommittedEvents(outcome.events, "pricing");
        return outcome.receipt;
      }
      const installed = await write(async (client) => {
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
        await enrollOwnerPredicateWriteInTransaction(client, accountPredicate);
        if (standing) await lockRepricingStanding(client, accountKey, standing.incarnation);
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
        if (standing) {
          const pending = await client.query(
            "SELECT 1 FROM pricing_repricing_configuration_heads WHERE seller_account_id = $1 AND requested_revision <> installed_revision LIMIT 1",
            [input.accountId],
          );
          if (!pending.rows.length) {
            const opened = await standing.epochs.installClosureInTransaction(client, accountKey);
            if (opened.status !== "OPEN") throw new ConfigurationEpochError("Pricing standing did not reopen");
            await client.query("UPDATE pricing_repricing_standing SET epoch = $2 WHERE key = $1", [
              accountKey,
              opened.epoch,
            ]);
          }
        }
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
