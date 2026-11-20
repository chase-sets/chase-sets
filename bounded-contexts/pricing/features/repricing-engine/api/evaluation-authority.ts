import type { ConfigurationConsumer, ConfigurationEpochGrant } from "@chase-sets/event-core/configuration-epoch";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  assertRequestTerminalBinding,
  reservationIdentity,
  sameRequestTerminalBinding,
  type RequestTerminalBinding,
  type ReserveOwnerStreamInput,
} from "@chase-sets/event-core/owner-stream-reservation";
import {
  assertExactPreparationTime,
  CONFIGURATION_EPOCH_LOCK_SQL,
  createPostgresOwnerStreamReservationStore,
  lockOwnerStreamInvalidationsInTransaction,
  openRequestTerminalInTransaction,
  ownerPredicateKey,
  reserveOwnerPredicateInTransaction,
  withConfigurationEpochTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { moneyToCents } from "@chase-sets/primitives/money";
import type { EconomicsServices } from "../../economics/api/services";
import {
  lockRepricingStanding,
  repricingStandingKey,
  type RepricingConfigurationWriter,
  type RepricingStanding,
} from "../../repricing-policies/api/configuration";
import {
  assertEvaluationBinding,
  evaluationBindingSchema,
  evaluationDeadline,
  evaluationDigest,
  exactUtc,
  readCompetitorCapture,
  type EvaluationBinding,
} from "../domain/evaluation-authority";
import { planRepricingRound } from "../domain/round";
import { assertExactEvaluationEvidence } from "../domain/evaluation-evidence";
import { repricingEnginePolicy } from "../domain/policy";
import { reserveDailyChangesInTransaction, refundDailyChanges } from "../read-model/daily-change-budget";
import {
  assignedPolicy,
  captureCompetitors,
  capturePlatformPolicy,
  categoryPredicateIds,
} from "../read-model/evaluation-inputs";
import { activeProductFreeze, readProductRoundState } from "../read-model/product-round-state";
import { loadRepricingRoundInputs, type RepricingRoundListing } from "../read-model/queries";
import {
  captureEvaluationMembers,
  captureOwnCategories,
  captureOwnInventory,
  captureOwnListingMember,
  evaluationOwnerIdentity,
  readCommittedCategories,
  type EvaluationMember,
  type EvaluationOwner,
} from "./evaluation-owner-inputs";

export const repricingPlatformSelector = `repricing-platform-policy/${repricingEnginePolicy.policyKey}`;
const decisionPurpose = "pricing-evaluated-decision";
const budgetPurpose = "pricing-daily-change-budget";

export type PricingEvaluationListing = Readonly<{
  inventoryItemId: string;
  priceAmount: string;
  priceCurrencyCode: string;
  basePriceRevision: number;
  quantityCap: number;
  createdAt: string;
  grading: "graded" | "raw";
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
}>;

export type PricingEvaluationOwners = Readonly<{
  marketplace: PgTransactionalPool;
  inventory: PgTransactionalPool;
  catalog: PgTransactionalPool;
  captureInventoryStock: (
    target: Pick<EvaluationBinding, "listingId" | "accountId" | "catalogItemId" | "productId"> &
      Pick<PricingEvaluationListing, "inventoryItemId" | "selectedOptions"> &
      Readonly<{ channelConnectionId: string }>,
    context: EventStoreContext,
  ) => Promise<
    Readonly<{
      itemVersion: number;
      incarnation: string;
      stock: Readonly<{
        itemId: string;
        accountId: string;
        totalQuantity: number;
        heldQuantity: number;
        availableQuantity: number;
      }>;
      allocation: Readonly<{ revision: number }>;
    }>
  >;
}>;
type DecisionRecord = Readonly<{
  terminal_binding: RequestTerminalBinding;
  evidence: EvaluationEvidence;
  evidence_hash: string;
  command_fingerprint: string;
  seller_account_id: string;
  budget_day: string;
  status: "PREPARED" | "COMMITTED" | "ABORTED";
}>;
type EvaluationEvidence = Readonly<{
  version: 1;
  binding: EvaluationBinding;
  challengeTime: string;
  deadline: string;
  grants: readonly ConfigurationEpochGrant[];
  members: readonly EvaluationMember[];
  listing: RepricingRoundListing;
  inputs: unknown;
  competitors: ReturnType<typeof readCompetitorCapture>;
  evaluation: ReturnType<typeof planRepricingRound>[number];
}>;
export type PreparedPricingEvaluation = Readonly<{
  terminal: RequestTerminalBinding;
  grants: readonly ConfigurationEpochGrant[];
  evidenceHash: string;
}>;

export function createPricingEvaluationAuthority(
  deps: Readonly<{
    pool: PgTransactionalPool;
    owners: PricingEvaluationOwners;
    eventStore: PostgresEventStore;
    economy: Pick<EconomicsServices, "resolve">;
    configuration: RepricingConfigurationWriter;
    standing: RepricingStanding;
    hasConsumerRoute: (consumer: ConfigurationConsumer) => boolean;
  }>,
) {
  const { captureInventoryStock, ...ownerPools } = deps.owners;
  const owners: Readonly<Record<EvaluationOwner, PgTransactionalPool>> = { ...ownerPools, pricing: deps.pool };
  const consumer = owners.marketplace;
  const terminalRoute = createPostgresOwnerStreamReservationStore({
    ownerPool: deps.pool,
    consumerPool: consumer,
    applyInvalidation: async () => {
      throw new Error("Pricing evaluation cannot apply an owner write.");
    },
    applyInboundEvidence: async () => {
      throw new Error("Pricing evaluation cannot apply inbound evidence.");
    },
  });
  const reservationRoute = (ownerPool: PgTransactionalPool) =>
    createPostgresOwnerStreamReservationStore({
      ownerPool,
      consumerPool: consumer,
      applyInvalidation: async () => {
        throw new Error("Pricing evaluation cannot apply an owner write.");
      },
      applyInboundEvidence: async () => {
        throw new Error("Pricing evaluation cannot apply inbound evidence.");
      },
    });
  const find = async (db: PgQueryable, requestId: string) =>
    (
      await db.query<DecisionRecord>(
        `SELECT terminal_binding, evidence, evidence_hash, command_fingerprint, seller_account_id,
         budget_day::text, status FROM pricing_evaluated_decisions WHERE request_id = $1`,
        [requestId],
      )
    ).rows[0];

  async function issueChallenge(binding: EvaluationBinding) {
    // Read-only on the final consumer; no process-local or caller-supplied time enters the authority.
    const result = await consumer.query<{ time: Date }>(
      `SELECT clock_timestamp() AS time FROM event_configuration_store_identity
       WHERE singleton = true AND store_id = $1 AND incarnation = $2`,
      [binding.consumer.storeId, binding.consumer.incarnation],
    );
    if (result.rows.length !== 1) throw new Error("Marketplace DB-time challenge is unavailable.");
    return result.rows[0]!.time.toISOString();
  }

  async function register(key: string, identity: ConfigurationConsumer) {
    const { incarnation, epochs } = await deps.standing.source();
    await withConfigurationEpochTransaction(deps.pool, (client) => lockRepricingStanding(client, key, incarnation));
    await epochs.registerConsumer(key, identity);
    return epochs;
  }

  async function capture(
    binding: EvaluationBinding,
    listing: PricingEvaluationListing,
    context: EventStoreContext,
  ): Promise<EvaluationEvidence> {
    const accountKey = repricingStandingKey(binding.accountId);
    if (listing.basePriceRevision !== binding.decision.basePriceRevision)
      throw new Error("Pricing evaluation names another base price.");
    if (
      listing.priceCurrencyCode !== binding.priceCurrencyCode ||
      !Number.isSafeInteger(listing.quantityCap) ||
      listing.quantityCap < 1
    )
      throw new Error("Listing evaluator inputs are unavailable.");
    const accountEpochs = await register(accountKey, binding.consumer);
    const platformEpochs = await register(repricingPlatformSelector, binding.consumer);
    await Promise.all([
      evaluationOwnerIdentity(owners.inventory, "inventory"),
      evaluationOwnerIdentity(owners.catalog, "catalog"),
    ]);
    const challengeTime = exactUtc.parse(await issueChallenge(binding));
    return withConfigurationEpochTransaction(deps.pool, async (db) => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      for (const key of [accountKey, repricingPlatformSelector].sort())
        await db.query(CONFIGURATION_EPOCH_LOCK_SQL, [key]);
      const grants = [];
      for (const [key, epochs] of [
        [accountKey, accountEpochs],
        [repricingPlatformSelector, platformEpochs],
      ] as const) {
        const grant = await epochs.captureGrantInTransaction(db, key, binding.consumer);
        const head = await db.query<{ incarnation: string; epoch: number }>(
          "SELECT incarnation, epoch FROM pricing_repricing_standing WHERE key = $1",
          [key],
        );
        if (head.rows[0]?.incarnation !== grant.sourceIncarnation || head.rows[0].epoch !== grant.epoch)
          throw new Error("Pricing standing journal disagrees with its canonical head.");
        grants.push(grant);
      }
      const installed = await deps.configuration.captureAccount(db, binding.accountId, "installed");
      if (
        installed.halt.state.engaged ||
        binding.decision.standingAuthorizationId !== accountKey ||
        binding.decision.standingAuthorizationRevision !== String(grants[0]!.epoch)
      )
        throw new Error("Installed Pricing standing does not authorize this decision.");
      const categoryKeys = categoryPredicateIds(installed.policies, binding.listingId);
      const [category, inventory, listingMembers] = await Promise.all([
        captureOwnCategories(owners.catalog, binding, categoryKeys),
        captureOwnInventory(owners.inventory, binding, listing.inventoryItemId),
        captureOwnListingMember(owners.marketplace, binding),
      ]);
      const [inventoryMember] = inventory.members;
      // The enrolled generation was read first. An Inventory write before or after
      // this canonical snapshot makes the later membership reservation fail.
      const stockCapture = await captureInventoryStock(
        {
          listingId: binding.listingId,
          accountId: binding.accountId,
          catalogItemId: binding.catalogItemId,
          productId: binding.productId,
          inventoryItemId: listing.inventoryItemId,
          channelConnectionId: binding.target.connectionId,
          selectedOptions: listing.selectedOptions,
        },
        context,
      );
      if (
        stockCapture.itemVersion !== inventory.itemVersion ||
        stockCapture.incarnation !== inventoryMember?.seal.storeIncarnation
      )
        throw new Error("Inventory stock changed during Pricing capture.");
      const assignment = assignedPolicy(installed.policies, binding.listingId, category.categoryIds);
      if (!assignment?.state.policyId || !assignment.state.updatedAt || !assignment.state.maxChangesPerDay)
        throw new Error("Listing has no active installed Pricing assignment.");
      const freezeKey = ownerPredicateKey("repricing-product-freeze", binding.catalogItemId, binding.productId);
      const decisionKey = ownerPredicateKey("repricing-decision", binding.requestId);
      const budgetKey = ownerPredicateKey(
        "repricing-budget",
        binding.accountId,
        challengeTime.slice(0, 10),
        binding.requestId,
      );
      const local = await captureEvaluationMembers(db, "pricing", [freezeKey, decisionKey, budgetKey]);
      const freeze = await readProductRoundState(db, binding);
      if (activeProductFreeze(freeze, challengeTime)) throw new Error("Product is frozen for repricing.");
      const platform = await capturePlatformPolicy(db, deps.eventStore, challengeTime);
      const competitorCategories = await readCommittedCategories(owners.catalog, binding.catalogItemId);
      const competitors = await captureCompetitors(
        db,
        deps.configuration,
        {
          catalogItemId: binding.catalogItemId,
          productId: binding.productId,
        },
        binding.accountId,
        competitorCategories,
      );
      const own: RepricingRoundListing = {
        listingId: binding.listingId,
        sellerAccountId: binding.accountId,
        inventoryItemId: listing.inventoryItemId,
        catalogItemId: binding.catalogItemId,
        productId: binding.productId,
        priceAmount: listing.priceAmount,
        priceCurrencyCode: listing.priceCurrencyCode,
        quantityCap: listing.quantityCap,
        listingVersion: binding.listingVersion,
        listingStatus: "active",
        pauseReason: null,
        categoryIds: category.categoryIds,
        grading: listing.grading,
        createdAt: exactUtc.parse(listing.createdAt),
        costBasisAmount: inventory.costBasisAmount,
        costBasisCurrencyCode: inventory.costBasisCurrencyCode,
        policyId: assignment.state.policyId,
        policyRevision: exactUtc.parse(assignment.state.updatedAt),
        rules: assignment.state.rules,
        maxChangesPerDay: assignment.state.maxChangesPerDay,
        economics: null,
      };
      const round = await loadRepricingRoundInputs(db, {
        product: binding,
        capturedAt: challengeTime,
        ownAuthority: own,
        policy: platform.value,
        economics: deps.economy,
        economicsScope: binding.target,
        capturedAsks: competitors.parts.flatMap((part) => part.asks),
      });
      const evaluation = planRepricingRound(round, challengeTime, platform.value)[0];
      if (
        !evaluation ||
        evaluation.targetPriceAmount === null ||
        evaluation.action !== "update-price" ||
        evaluation.portfolioPlanId !== undefined ||
        moneyToCents(evaluation.targetPriceAmount) !== moneyToCents(binding.priceAmount)
      )
        throw new Error("Pricing has no favorable exact decision for the requested pair.");
      const curve = round.demandCurve;
      const estimate =
        round.marketEstimate === null
          ? null
          : {
              ...round.marketEstimate,
              freshUntil: new Date(round.marketEstimate.freshUntil).toISOString(),
            };
      const sale =
        round.lastSold === null
          ? null
          : {
              ...round.lastSold,
              soldAt: new Date(round.lastSold.soldAt).toISOString(),
            };
      const saleExpiry =
        sale && new Date(Date.parse(sale.soldAt) + platform.value.lastSoldFreshForDays * 86_400_000).toISOString();
      const nextDay = new Date(Date.parse(`${challengeTime.slice(0, 10)}T00:00:00.000Z`) + 86_400_000).toISOString();
      const bounds = [nextDay, ...platform.bounds, estimate?.freshUntil, curve?.freshUntil, saleExpiry].filter(
        (bound): bound is string => typeof bound === "string" && bound >= challengeTime,
      );
      bounds.push(...grants.flatMap(({ validUntil }) => (validUntil === undefined ? [] : [validUntil])));
      const deadline = evaluationDeadline({
        challengeTime,
        validityBounds: bounds,
        listingCreatedAt: listing.createdAt,
        rules: own.rules,
      });
      return {
        version: 1,
        binding,
        challengeTime,
        deadline,
        grants,
        members: [...local, ...category.members, ...inventory.members, ...listingMembers],
        listing: round.listings[0]!,
        competitors,
        evaluation,
        inputs: {
          standing: installed,
          assignment,
          platform,
          freeze: freeze && {
            ...freeze,
            next_eligible_at: new Date(freeze.next_eligible_at).toISOString(),
            updated_at: new Date(freeze.updated_at).toISOString(),
            frozen_until: freeze.frozen_until === null ? null : new Date(freeze.frozen_until).toISOString(),
          },
          catalogVersion: category.version,
          inventoryOrigin: inventory.origin,
          inventoryVersion: inventory.itemVersion,
          stock: stockCapture.stock,
          allocationRevision: stockCapture.allocation.revision,
          estimate,
          sale,
          curve,
          marketSources: round.marketSources,
          economics: round.healthEconomics?.get(own.listingId) ?? null,
        },
      };
    });
  }

  function manifest(evidence: EvaluationEvidence): RequestTerminalBinding {
    const { binding, challengeTime, deadline } = evidence;
    const target = {
      listingId: binding.listingId,
      productId: binding.productId,
      accountId: binding.accountId,
      target: binding.target,
      decision: binding.decision,
      priceAmount: binding.priceAmount,
      priceCurrencyCode: binding.priceCurrencyCode,
      evidenceHash: evaluationDigest(evidence),
    };
    const reservations = evidence.members.map(
      ({ owner, key, seal }): ReserveOwnerStreamInput => ({
        reservationId: `${binding.requestId}:${evaluationDigest([owner, key])}`,
        operationId: binding.requestId,
        ownerStreamId: key,
        resourceKey: key,
        seal,
        purpose: key.startsWith('predicate:["repricing-decision"')
          ? decisionPurpose
          : key.startsWith('predicate:["repricing-budget"')
            ? budgetPurpose
            : "pricing-own-predicate",
        consumer: { ...binding.consumer, requestId: binding.requestId },
        target,
        commandFingerprint: binding.commandFingerprint,
      }),
    );
    const terminal = {
      consumerStoreId: binding.consumer.storeId,
      consumerIncarnation: binding.consumer.incarnation,
      requestId: binding.requestId,
      commandFingerprint: binding.commandFingerprint,
      target,
      reservations,
      preparationDeadline: deadline,
      preparationNotBefore: challengeTime,
    };
    assertRequestTerminalBinding(terminal);
    return terminal;
  }

  function validateEvidence(evidence: EvaluationEvidence) {
    const parsed = assertExactEvaluationEvidence(evidence);
    const { binding } = parsed;
    const expected = [
      ["marketplace", ownerPredicateKey("repricing-listing", binding.listingId)],
      ["inventory", ownerPredicateKey("repricing-stock", binding.accountId, parsed.listing.inventoryItemId)],
      ["pricing", ownerPredicateKey("repricing-product-freeze", binding.catalogItemId, binding.productId)],
      ["pricing", ownerPredicateKey("repricing-decision", binding.requestId)],
      [
        "pricing",
        ownerPredicateKey("repricing-budget", binding.accountId, parsed.challengeTime.slice(0, 10), binding.requestId),
      ],
      ...categoryPredicateIds(parsed.inputs.standing.policies, binding.listingId).map((category) => [
        "catalog",
        ownerPredicateKey("repricing-catalog-category", binding.catalogItemId, category),
      ]),
    ];
    const members = parsed.members.map(({ owner, key }) => reservationIdentity([owner, key])).sort();
    if (
      reservationIdentity(members) !== reservationIdentity(expected.map(reservationIdentity).sort()) ||
      parsed.grants.length !== 2 ||
      parsed.grants[0]?.key !== repricingStandingKey(binding.accountId) ||
      String(parsed.grants[0].epoch) !== binding.decision.standingAuthorizationRevision ||
      parsed.grants[1]?.key !== repricingPlatformSelector ||
      parsed.grants.some(
        (grant) =>
          reservationIdentity(grant.consumer) !== reservationIdentity(binding.consumer) ||
          parsed.members.some(
            ({ owner, seal }) => owner === "pricing" && seal.storeIncarnation !== grant.sourceIncarnation,
          ),
      ) ||
      parsed.members.some(
        ({ owner, seal }) => owner === "marketplace" && seal.storeIncarnation !== binding.consumer.incarnation,
      )
    )
      throw new Error("Pricing evidence has an incomplete or foreign participant set.");
  }

  function check(prior: DecisionRecord, binding: EvaluationBinding) {
    assertEvaluationBinding(prior.evidence.binding, binding);
    validateEvidence(prior.evidence);
    if (
      prior.evidence.version !== 1 ||
      prior.evidence_hash !== evaluationDigest(prior.evidence) ||
      prior.seller_account_id !== binding.accountId ||
      prior.command_fingerprint !== binding.commandFingerprint ||
      !sameRequestTerminalBinding(prior.terminal_binding, manifest(prior.evidence))
    )
      throw new Error("Corrupt Evaluated Decision authority.");
    return prior;
  }

  async function retain(evidence: EvaluationEvidence, terminal: RequestTerminalBinding) {
    const binding = evidence.binding;
    const { epochs } = await deps.standing.source();
    return withConfigurationEpochTransaction(deps.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('pricing_decision:' || $1, 0))", [
        binding.requestId,
      ]);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('pricing_evaluation:' || $1, 0))", [
        binding.decision.evaluationId,
      ]);
      const prior = await find(db, binding.requestId);
      if (prior) return check(prior, binding);
      for (const expected of [...evidence.grants].sort((a, b) => a.key.localeCompare(b.key))) {
        const current = await epochs.captureGrantInTransaction(db, expected.key, binding.consumer);
        if (reservationIdentity(current) !== reservationIdentity(expected))
          throw new Error("Pricing standing changed during preparation.");
      }
      const keys = evidence.members.filter((member) => member.owner === "pricing").map(({ key }) => key);
      await lockOwnerStreamInvalidationsInTransaction(db, keys);
      for (const key of keys) {
        const claim = terminal.reservations.find((value) => value.ownerStreamId === key)!;
        if ((await reserveOwnerPredicateInTransaction(db, claim)).status !== "OPEN")
          throw new Error("Pricing promise is already terminal.");
      }
      const budgetDay = evidence.challengeTime.slice(0, 10);
      if (
        (await reserveDailyChangesInTransaction(
          db,
          binding.accountId,
          budgetDay,
          evidence.listing.maxChangesPerDay,
          1,
          () => assertExactPreparationTime(consumer, terminal),
        )) !== 1
      )
        throw new Error("Pricing daily change budget is exhausted.");
      const evidenceHash = evaluationDigest(evidence);
      await db.query(
        `INSERT INTO pricing_evaluated_decisions
         (request_id, evaluation_id, command_fingerprint, seller_account_id, budget_day, terminal_binding, evidence, evidence_hash, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PREPARED')`,
        [
          binding.requestId,
          binding.decision.evaluationId,
          binding.commandFingerprint,
          binding.accountId,
          budgetDay,
          terminal,
          evidence,
          evidenceHash,
        ],
      );
      return (await find(db, binding.requestId))!;
    });
  }

  async function readOriginal(terminal: RequestTerminalBinding) {
    const result = await consumer.query<{ binding: RequestTerminalBinding; status: "OPEN" | "COMMITTED" | "ABORTED" }>(
      `SELECT binding, status FROM event_request_terminals
       WHERE consumer_store_id = $1 AND request_id = $2
       AND EXISTS (SELECT 1 FROM event_configuration_store_identity
         WHERE singleton = true AND store_id = $1 AND incarnation = $3)`,
      [terminal.consumerStoreId, terminal.requestId, terminal.consumerIncarnation],
    );
    const original = result.rows[0];
    if (!original || !sameRequestTerminalBinding(original.binding, terminal)) return undefined;
    return original.status;
  }

  async function settle(row: DecisionRecord) {
    const terminal = row.terminal_binding;
    const status = await readOriginal(terminal);
    if (status !== "COMMITTED" && status !== "ABORTED") return;
    for (const owner of Object.keys(owners) as EvaluationOwner[]) {
      const ids = terminal.reservations
        .filter(({ ownerStreamId }) =>
          row.evidence.members.some((member) => member.owner === owner && member.key === ownerStreamId),
        )
        .map(({ reservationId }) => reservationId);
      if (!ids.length) continue;
      await withConfigurationEpochTransaction(owners[owner], async (db) => {
        await db.query(
          `UPDATE event_owner_stream_reservations SET status = 'RELEASED', release_status = $2, released_at = now()
           WHERE reservation_id = ANY($1::text[]) AND status = 'OPEN' AND command_fingerprint = $3`,
          [ids, status, terminal.commandFingerprint],
        );
        if (owner !== "pricing") return;
        const updated = await db.query(
          "UPDATE pricing_evaluated_decisions SET status = $2 WHERE request_id = $1 AND status = 'PREPARED'",
          [terminal.requestId, status],
        );
        if (updated.rowCount === 1 && status === "ABORTED")
          await refundDailyChanges(db, row.seller_account_id, row.budget_day, 1);
      });
    }
  }

  async function settlePriorForAccount(accountId: string, day: string) {
    const pending = await deps.pool.query<{ request_id: string }>(
      `SELECT request_id FROM pricing_evaluated_decisions
       WHERE seller_account_id = $1 AND budget_day = $2 AND status = 'PREPARED'
       ORDER BY request_id LIMIT 128`,
      [accountId, day],
    );
    for (const { request_id } of pending.rows) {
      const prior = await find(deps.pool, request_id);
      if (prior?.status === "PREPARED") await settle(check(prior, prior.evidence.binding));
    }
  }

  async function assertPrepared(row: DecisionRecord, open: boolean): Promise<PreparedPricingEvaluation> {
    const terminal = row.terminal_binding;
    if (row.status !== "PREPARED") throw new Error("Evaluated Decision is already terminal.");
    for (const [index, member] of row.evidence.members.entries()) {
      const expected = terminal.reservations[index]!;
      const actual = await reservationRoute(owners[member.owner]).getReservation(expected.reservationId);
      if (
        !actual ||
        actual.status !== "OPEN" ||
        reservationIdentity(actual.consumer) !== reservationIdentity(expected.consumer) ||
        reservationIdentity(actual.seal) !== reservationIdentity(expected.seal) ||
        reservationIdentity(actual.target) !== reservationIdentity(terminal.target) ||
        actual.commandFingerprint !== terminal.commandFingerprint ||
        actual.resourceKey !== member.key ||
        actual.ownerStreamId !== member.key ||
        actual.operationId !== expected.operationId ||
        actual.purpose !== expected.purpose
      )
        throw new Error("Pricing preparation is incomplete.");
    }
    if (open) {
      const opened = await withConfigurationEpochTransaction(consumer, (db) =>
        openRequestTerminalInTransaction(db, terminal),
      );
      if (opened.status !== "OPEN") throw new Error("Evaluated Decision is already terminal.");
    } else {
      if ((await readOriginal(terminal)) !== "OPEN")
        throw new Error("Original Evaluated Decision terminal is unavailable.");
      await assertExactPreparationTime(consumer, terminal);
    }
    return { terminal, grants: row.evidence.grants, evidenceHash: row.evidence_hash };
  }

  return {
    async prepare(
      raw: EvaluationBinding,
      listing: PricingEvaluationListing,
      context: EventStoreContext,
    ): Promise<PreparedPricingEvaluation> {
      const binding = evaluationBindingSchema.parse(raw);
      if (
        !deps.hasConsumerRoute(binding.consumer) ||
        context.tenantId !== binding.tenantId ||
        context.audit.forAccountId !== binding.accountId ||
        context.audit.performedByUserId !== binding.principal.userId ||
        binding.decision.evaluationRevision !== "1" ||
        !binding.decision.evaluationId.startsWith("evd_") ||
        binding.decision.standingAuthorizationId !== repricingStandingKey(binding.accountId)
      )
        throw new Error("Pricing decision authority is unavailable.");
      const prior = await find(deps.pool, binding.requestId);
      if (prior) return assertPrepared(check(prior, binding), false);
      const current = await capture(binding, listing, context);
      validateEvidence(current);
      const terminal = manifest(current);
      await settlePriorForAccount(binding.accountId, current.challengeTime.slice(0, 10));
      const retained = await retain(current, terminal);
      if (!sameRequestTerminalBinding(retained.terminal_binding, terminal)) return assertPrepared(retained, false);
      try {
        for (const owner of ["catalog", "inventory", "marketplace"] as const) {
          await withConfigurationEpochTransaction(owners[owner], async (db) => {
            const keys = current.members.filter((member) => member.owner === owner).map(({ key }) => key);
            await lockOwnerStreamInvalidationsInTransaction(db, keys);
            for (const key of keys) {
              const claim = terminal.reservations.find((value) => value.ownerStreamId === key)!;
              await reserveOwnerPredicateInTransaction(db, claim);
            }
            if (keys.length) await assertExactPreparationTime(owner === "marketplace" ? db : consumer, terminal);
          });
        }
        return await assertPrepared(retained, true);
      } catch (error) {
        await terminalRoute
          .abortRequestTerminal(terminal)
          .then(() => settle(retained))
          .catch(() => undefined);
        throw error;
      }
    },
    async settle(requestId: string, commandFingerprint: string, abort: boolean) {
      const row = await find(deps.pool, requestId);
      if (!row) return;
      if (row.command_fingerprint !== commandFingerprint) throw new Error("Evaluated Decision command changed.");
      const checked = check(row, row.evidence.binding);
      if (abort && (await readOriginal(checked.terminal_binding)) === "OPEN")
        await terminalRoute.abortRequestTerminal(checked.terminal_binding);
      await settle(checked);
    },
  };
}

export type PricingEvaluationAuthority = ReturnType<typeof createPricingEvaluationAuthority>;
