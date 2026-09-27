import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { OrderingDomainError, type OrderSourceType } from "../domain/common";

export type EvidenceWindowSourceIdentity = Readonly<{
  sourceType: OrderSourceType;
  sourceReferenceId: string;
  buyerAccountId: string;
}>;

export type EvidenceWindowSource = Readonly<{
  windowId: string;
  subInvocation: "2a" | "2b";
  sourceIdentity: EvidenceWindowSourceIdentity;
  windowOpenedAt: string;
  creatorState: "open" | "closed";
  dischargedAt: string | null;
  terminalReport: unknown | null;
  version: number;
}>;

type SourceRow = Readonly<{
  window_id: string;
  sub_invocation: "2a" | "2b";
  source_type: OrderSourceType;
  source_reference_id: string;
  buyer_account_id: string;
  window_opened_at: Date | string;
  creator_state: "open" | "closed";
  discharged_at: Date | string | null;
  terminal_report: unknown | null;
  version: number;
}>;

const sourceColumns = `window_id, sub_invocation, source_type, source_reference_id, buyer_account_id,
  window_opened_at, creator_state, discharged_at, terminal_report, version`;
const sourceTypes: readonly string[] = ["cart-checkout", "buy-now", "offer-acceptance"];
const windowIdPattern = /^[0-9a-f]{32}$/;

function mapSource(row: SourceRow): EvidenceWindowSource {
  return {
    windowId: row.window_id,
    subInvocation: row.sub_invocation,
    sourceIdentity: {
      sourceType: row.source_type,
      sourceReferenceId: row.source_reference_id,
      buyerAccountId: row.buyer_account_id,
    },
    windowOpenedAt: new Date(row.window_opened_at).toISOString(),
    creatorState: row.creator_state,
    dischargedAt: row.discharged_at === null ? null : new Date(row.discharged_at).toISOString(),
    terminalReport: row.terminal_report,
    version: Number(row.version),
  };
}

function assertIdentity(source: EvidenceWindowSourceIdentity): void {
  if (
    !sourceTypes.includes(source.sourceType) ||
    !source.sourceReferenceId ||
    !source.buyerAccountId ||
    new TextEncoder().encode(source.sourceReferenceId).length > 256 ||
    new TextEncoder().encode(source.buyerAccountId).length > 256
  ) {
    throw new OrderingDomainError("Evidence window source identity is invalid.");
  }
}

function sameIdentity(a: EvidenceWindowSourceIdentity, b: EvidenceWindowSourceIdentity) {
  return (
    a.sourceType === b.sourceType &&
    a.sourceReferenceId === b.sourceReferenceId &&
    a.buyerAccountId === b.buyerAccountId
  );
}

export async function bindEvidenceWindowSource(
  db: PgTransactionalPool,
  input: Readonly<{
    windowId: string;
    subInvocation: "2a" | "2b";
    sourceIdentity: EvidenceWindowSourceIdentity;
    windowOpenedAt: string;
  }>,
): Promise<Readonly<{ outcome: "bound" | "existing" | "drift" | "stale"; source?: EvidenceWindowSource }>> {
  assertIdentity(input.sourceIdentity);
  const openedAt = new Date(input.windowOpenedAt);
  if (
    !windowIdPattern.test(input.windowId) ||
    !["2a", "2b"].includes(input.subInvocation) ||
    !Number.isFinite(openedAt.getTime()) ||
    openedAt.getTime() > Date.now()
  ) {
    throw new OrderingDomainError("Evidence window source binding is invalid.");
  }
  return withPgTransaction(db, async (client) => {
    const inserted = await client.query<SourceRow>(
      `INSERT INTO ordering_evidence_window_sources
       (window_id, sub_invocation, source_type, source_reference_id, buyer_account_id, window_opened_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       ON CONFLICT DO NOTHING RETURNING ${sourceColumns}`,
      [
        input.windowId,
        input.subInvocation,
        input.sourceIdentity.sourceType,
        input.sourceIdentity.sourceReferenceId,
        input.sourceIdentity.buyerAccountId,
        openedAt.toISOString(),
      ],
    );
    if (inserted.rows[0]) return { outcome: "bound" as const, source: mapSource(inserted.rows[0]) };

    const bySlot = await client.query<SourceRow>(
      `SELECT ${sourceColumns} FROM ordering_evidence_window_sources
       WHERE window_id = $1 AND sub_invocation = $2 FOR UPDATE`,
      [input.windowId, input.subInvocation],
    );
    const row = bySlot.rows[0];
    if (!row) return { outcome: "drift" as const };
    const source = mapSource(row);
    if (
      !sameIdentity(source.sourceIdentity, input.sourceIdentity) ||
      source.windowOpenedAt !== openedAt.toISOString()
    ) {
      return { outcome: "drift" as const };
    }
    return source.creatorState === "open"
      ? { outcome: "existing" as const, source }
      : { outcome: "stale" as const, source };
  });
}

export async function readEvidenceWindowSources(
  db: PgQueryable,
  windowId: string,
): Promise<readonly EvidenceWindowSource[]> {
  if (!windowIdPattern.test(windowId)) throw new OrderingDomainError("Evidence window id is invalid.");
  const result = await db.query<SourceRow>(
    `SELECT ${sourceColumns} FROM ordering_evidence_window_sources WHERE window_id = $1 ORDER BY sub_invocation`,
    [windowId],
  );
  if (result.rows.length > 2) throw new Error("Evidence window source membership exceeds its bound.");
  return result.rows.map(mapSource);
}

export async function closeEvidenceWindowSource(
  db: PgTransactionalPool,
  input: Readonly<{ windowId: string; subInvocation: "2a" | "2b"; expectedVersion: number }>,
): Promise<Readonly<{ outcome: "closed" | "existing" | "stale" | "unknown"; source?: EvidenceWindowSource }>> {
  if (
    !windowIdPattern.test(input.windowId) ||
    !["2a", "2b"].includes(input.subInvocation) ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.expectedVersion >= 2147483647
  ) {
    throw new OrderingDomainError("Evidence window source close request is invalid.");
  }
  return withPgTransaction(db, async (client) => {
    const updated = await client.query<SourceRow>(
      `UPDATE ordering_evidence_window_sources SET creator_state = 'closed', version = version + 1
       WHERE window_id = $1 AND sub_invocation = $2 AND creator_state = 'open' AND version = $3
       RETURNING ${sourceColumns}`,
      [input.windowId, input.subInvocation, input.expectedVersion],
    );
    if (updated.rows[0]) return { outcome: "closed" as const, source: mapSource(updated.rows[0]) };
    const reread = await client.query<SourceRow>(
      `SELECT ${sourceColumns} FROM ordering_evidence_window_sources
       WHERE window_id = $1 AND sub_invocation = $2`,
      [input.windowId, input.subInvocation],
    );
    const row = reread.rows[0];
    if (!row) return { outcome: "unknown" as const };
    const source = mapSource(row);
    return { outcome: source.creatorState === "closed" ? ("existing" as const) : ("stale" as const), source };
  });
}

export async function lockOpenEvidenceWindowSource(
  client: PgQueryable,
  source: EvidenceWindowSourceIdentity,
): Promise<EvidenceWindowSource | null> {
  const result = await client.query<SourceRow>(
    `SELECT ${sourceColumns} FROM ordering_evidence_window_sources
     WHERE source_type = $1 AND source_reference_id = $2 AND buyer_account_id = $3 FOR SHARE`,
    [source.sourceType, source.sourceReferenceId, source.buyerAccountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const bound = mapSource(row);
  if (bound.creatorState !== "open") {
    throw new OrderingDomainError("Evidence window source creator is closed.");
  }
  return bound;
}

export async function withOpenEvidenceWindowSource<T>(
  db: PgTransactionalPool,
  source: EvidenceWindowSourceIdentity,
  work: (client: PgQueryable) => Promise<T>,
): Promise<T> {
  return withPgTransaction(db, async (client) => {
    const bound = await lockOpenEvidenceWindowSource(client, source);
    if (!bound) throw new OrderingDomainError("Evidence window source binding is missing.");
    return work(client);
  });
}

type PurchaseClaimRow = Readonly<{
  listing_id: string;
  quantity: number;
  status: "pending" | "claimed" | "released";
  usage_residue_upper_bound_units: number | null;
  claimed_day: string;
}>;

type RootRow = Readonly<{ order_ids: unknown; status: "pending" | "created" }>;
type CapacityRow = Readonly<{ order_id: string; seller_account_id: string; status: "claimed" | "released" }>;

export type EvidenceWindowSourceReport = Readonly<{
  outcome: "owed" | "unknown" | "discharged" | "discharged-with-bounded-usage-residue";
  creatorState: "open" | "closed";
  surfaces: Readonly<{
    purchaseLimits: "owed" | "unknown" | "discharged";
    usage: "owed" | "unknown" | "discharged" | "discharged-with-bounded-usage-residue";
    sourceClaim: "owed" | "unknown" | "discharged";
    capacityAndSellerSignals: "owed" | "unknown" | "discharged";
    orderStreams: "owed" | "unknown" | "discharged" | "not-created";
  }>;
  purchaseLimitResidue: readonly Readonly<{
    listingId: string;
    buyerAccountId: string;
    residueUpperBoundUnits: number;
  }>[];
}>;

export type EvidenceWindowSourceReaders = Readonly<{
  readOrder: (orderId: string, source: EvidenceWindowSource) => Promise<"missing" | "live" | "cancelled" | "unknown">;
  readSellerSignal: (sellerAccountId: string, db: PgQueryable) => Promise<"converged" | "owed" | "unknown">;
}>;

type SourceFacts = Readonly<{
  source: EvidenceWindowSource;
  purchaseClaims: readonly PurchaseClaimRow[];
  usageListingIds: readonly string[];
  orderIds: readonly string[];
  rootPresent: boolean;
  capacityClaims: readonly CapacityRow[];
  corrupt: boolean;
}>;

async function readFacts(db: PgQueryable, source: EvidenceWindowSource): Promise<SourceFacts> {
  const identity = source.sourceIdentity;
  const claims = await db.query<PurchaseClaimRow>(
    `SELECT listing_id, quantity, status, usage_residue_upper_bound_units,
       claimed_at::date::text AS claimed_day
     FROM ordering_listing_purchase_limit_claims
     WHERE source_type = $1 AND source_reference_id = $2 AND buyer_account_id = $3
     ORDER BY listing_id LIMIT 257`,
    [identity.sourceType, identity.sourceReferenceId, identity.buyerAccountId],
  );
  const roots = await db.query<RootRow>(
    `SELECT order_ids, status FROM ordering_order_source_claims
     WHERE source_type = $1 AND source_reference_id = $2 AND buyer_account_id = $3`,
    [identity.sourceType, identity.sourceReferenceId, identity.buyerAccountId],
  );
  const usage =
    claims.rows.length <= 256
      ? await db.query<{ listing_id: string }>(
          `SELECT listing_id FROM ordering_listing_purchase_limit_usage
       WHERE buyer_account_id = $1 AND listing_id = ANY($2::text[])`,
          [identity.buyerAccountId, claims.rows.map((row) => row.listing_id)],
        )
      : { rows: [] as { listing_id: string }[] };
  const root = roots.rows[0];
  const rawIds = root?.order_ids;
  const orderIds =
    Array.isArray(rawIds) && rawIds.every((id) => typeof id === "string" && /^ord_[a-zA-Z0-9_-]+$/.test(id))
      ? (rawIds as string[])
      : [];
  const invalidRoot =
    Boolean(root) &&
    (orderIds.length === 0 ||
      orderIds.length > 64 ||
      new Set(orderIds).size !== orderIds.length ||
      (root?.status !== "pending" && root?.status !== "created"));
  const capacity = !invalidRoot
    ? await db.query<CapacityRow>(
        `SELECT order_id, seller_account_id, status FROM ordering_seller_open_order_claims
       WHERE order_id = ANY($1::text[]) ORDER BY order_id LIMIT 65`,
        [orderIds],
      )
    : { rows: [] as CapacityRow[] };
  return {
    source,
    purchaseClaims: claims.rows,
    usageListingIds: usage.rows.map((row) => row.listing_id),
    orderIds,
    rootPresent: Boolean(root),
    capacityClaims: capacity.rows,
    corrupt:
      claims.rows.length > 256 ||
      invalidRoot ||
      capacity.rows.length > 64 ||
      new Set(capacity.rows.map((claim) => claim.seller_account_id)).size > 64 ||
      capacity.rows.some((claim) => !["claimed", "released"].includes(claim.status) || !claim.seller_account_id) ||
      claims.rows.some(
        (claim) =>
          !["pending", "claimed", "released"].includes(claim.status) ||
          !Number.isInteger(Number(claim.quantity)) ||
          Number(claim.quantity) < 1 ||
          (claim.usage_residue_upper_bound_units !== null &&
            (!Number.isInteger(Number(claim.usage_residue_upper_bound_units)) ||
              Number(claim.usage_residue_upper_bound_units) < 1 ||
              Number(claim.usage_residue_upper_bound_units) > Number(claim.quantity))),
      ),
  };
}

export async function readEvidenceWindowSourceByIdentity(db: PgQueryable, identity: EvidenceWindowSourceIdentity) {
  assertIdentity(identity);
  const result = await db.query<SourceRow>(
    `SELECT ${sourceColumns} FROM ordering_evidence_window_sources
     WHERE source_type = $1 AND source_reference_id = $2 AND buyer_account_id = $3`,
    [identity.sourceType, identity.sourceReferenceId, identity.buyerAccountId],
  );
  return result.rows[0] ? mapSource(result.rows[0]) : null;
}

export async function observeEvidenceWindowSource(
  db: PgQueryable,
  identity: EvidenceWindowSourceIdentity,
  readers: EvidenceWindowSourceReaders,
): Promise<EvidenceWindowSourceReport | null> {
  const source = await readEvidenceWindowSourceByIdentity(db, identity);
  if (!source) return null;
  if (source.terminalReport !== null) return source.terminalReport as EvidenceWindowSourceReport;
  if (Date.now() > Date.parse(source.windowOpenedAt) + 30 * 86_400_000) {
    return {
      outcome: "unknown",
      creatorState: source.creatorState,
      surfaces: {
        purchaseLimits: "unknown",
        usage: "unknown",
        sourceClaim: "unknown",
        capacityAndSellerSignals: "unknown",
        orderStreams: "unknown",
      },
      purchaseLimitResidue: [],
    };
  }
  const facts = await readFacts(db, source);
  const residue = facts.purchaseClaims
    .filter((claim) => claim.usage_residue_upper_bound_units !== null)
    .map((claim) => ({
      listingId: claim.listing_id,
      buyerAccountId: identity.buyerAccountId,
      residueUpperBoundUnits: Number(claim.usage_residue_upper_bound_units),
    }));
  const purchaseLimits = facts.corrupt
    ? ("unknown" as const)
    : facts.purchaseClaims.some((claim) => claim.status !== "released")
      ? ("owed" as const)
      : ("discharged" as const);
  const usage =
    facts.corrupt ||
    facts.purchaseClaims.some(
      (claim) =>
        claim.status === "released" &&
        claim.usage_residue_upper_bound_units === null &&
        !facts.usageListingIds.includes(claim.listing_id),
    )
      ? ("unknown" as const)
      : purchaseLimits === "owed"
        ? ("owed" as const)
        : residue.length
          ? ("discharged-with-bounded-usage-residue" as const)
          : ("discharged" as const);
  const orderStates = facts.corrupt ? [] : await Promise.all(facts.orderIds.map((id) => readers.readOrder(id, source)));
  const capacityOrderIds = new Set(facts.capacityClaims.map((claim) => claim.order_id));
  const missingCapacityForCreatedOrder = orderStates.some(
    (state, index) => state !== "missing" && !capacityOrderIds.has(facts.orderIds[index]!),
  );
  const orderStreams = facts.corrupt
    ? ("unknown" as const)
    : orderStates.includes("unknown")
      ? ("unknown" as const)
      : orderStates.includes("live")
        ? ("owed" as const)
        : facts.orderIds.length === 0 || orderStates.every((state) => state === "missing")
          ? source.creatorState === "closed"
            ? ("not-created" as const)
            : ("owed" as const)
          : ("discharged" as const);
  const sellers = [...new Set(facts.capacityClaims.map((claim) => claim.seller_account_id))];
  const signals = facts.corrupt
    ? []
    : await Promise.all(sellers.map((sellerId) => readers.readSellerSignal(sellerId, db)));
  const capacityAndSellerSignals =
    facts.corrupt || missingCapacityForCreatedOrder || signals.includes("unknown")
      ? ("unknown" as const)
      : facts.capacityClaims.some((claim) => claim.status === "claimed") || signals.includes("owed")
        ? ("owed" as const)
        : ("discharged" as const);
  const sourceClaim = facts.corrupt
    ? ("unknown" as const)
    : facts.rootPresent
      ? ("owed" as const)
      : ("discharged" as const);
  const surfaces = { purchaseLimits, usage, sourceClaim, capacityAndSellerSignals, orderStreams };
  const outcome = Object.values(surfaces).includes("unknown")
    ? ("unknown" as const)
    : source.creatorState === "open" || Object.values(surfaces).includes("owed")
      ? ("owed" as const)
      : residue.length
        ? ("discharged-with-bounded-usage-residue" as const)
        : ("discharged" as const);
  return { outcome, creatorState: source.creatorState, surfaces, purchaseLimitResidue: residue };
}

export type EvidenceWindowSourceReleaseActions = EvidenceWindowSourceReaders &
  Readonly<{
    cancelOrder: (orderId: string) => Promise<void>;
    reconcileSeller: (sellerAccountId: string) => Promise<void>;
    decrementUsage: (
      client: PgQueryable,
      buyerAccountId: string,
      claims: readonly Readonly<{ listing_id: string; quantity: number; claimed_day: string }>[],
    ) => Promise<void>;
  }>;

export async function releaseEvidenceWindowSource(
  db: PgTransactionalPool,
  input: Readonly<{ sourceIdentity: EvidenceWindowSourceIdentity; windowOpenedAt: string }>,
  actions: EvidenceWindowSourceReleaseActions,
): Promise<EvidenceWindowSourceReport | null> {
  const source = await readEvidenceWindowSourceByIdentity(db, input.sourceIdentity);
  if (!source || source.windowOpenedAt !== input.windowOpenedAt) return null;
  if (source.terminalReport !== null) return source.terminalReport as EvidenceWindowSourceReport;
  if (source.creatorState !== "closed" || Date.now() > Date.parse(source.windowOpenedAt) + 30 * 86_400_000) {
    return observeEvidenceWindowSource(db, input.sourceIdentity, actions);
  }

  const facts = await withPgTransaction(db, async (client) => {
    const locked = await client.query<SourceRow>(
      `SELECT ${sourceColumns} FROM ordering_evidence_window_sources
       WHERE window_id = $1 AND sub_invocation = $2 FOR UPDATE`,
      [source.windowId, source.subInvocation],
    );
    const current = locked.rows[0] ? mapSource(locked.rows[0]) : null;
    if (!current || current.creatorState !== "closed" || current.terminalReport !== null) return null;
    const present = await readFacts(client, current);
    if (present.corrupt) return null;
    const released = await client.query<PurchaseClaimRow>(
      `UPDATE ordering_listing_purchase_limit_claims
       SET status = 'released', released_at = now(),
         usage_residue_upper_bound_units = CASE WHEN status = 'pending' THEN quantity ELSE NULL END
       WHERE source_type = $1 AND source_reference_id = $2 AND buyer_account_id = $3
         AND status IN ('pending', 'claimed')
       RETURNING listing_id, quantity, status, usage_residue_upper_bound_units,
         claimed_at::date::text AS claimed_day`,
      [
        current.sourceIdentity.sourceType,
        current.sourceIdentity.sourceReferenceId,
        current.sourceIdentity.buyerAccountId,
      ],
    );
    const formerlyClaimed = released.rows.filter((row) => row.usage_residue_upper_bound_units === null);
    await actions.decrementUsage(client, current.sourceIdentity.buyerAccountId, formerlyClaimed);
    return present;
  });
  if (!facts) return observeEvidenceWindowSource(db, input.sourceIdentity, actions);

  for (const orderId of facts.orderIds) {
    if ((await actions.readOrder(orderId, source)) === "live") await actions.cancelOrder(orderId);
  }
  const sellers = [...new Set(facts.capacityClaims.map((claim) => claim.seller_account_id))];
  for (const orderId of facts.orderIds) {
    await db.query(
      `UPDATE ordering_seller_open_order_claims SET status = 'released', released_at = now()
       WHERE order_id = $1 AND status = 'claimed'`,
      [orderId],
    );
  }
  for (const sellerId of sellers) await actions.reconcileSeller(sellerId);

  const observed = await observeEvidenceWindowSource(db, input.sourceIdentity, actions);
  if (
    !observed ||
    observed.outcome === "unknown" ||
    observed.surfaces.purchaseLimits !== "discharged" ||
    !["discharged", "discharged-with-bounded-usage-residue"].includes(observed.surfaces.usage) ||
    observed.surfaces.capacityAndSellerSignals !== "discharged" ||
    !["discharged", "not-created"].includes(observed.surfaces.orderStreams)
  )
    return observed;

  return withPgTransaction(db, async (client) => {
    const locked = await client.query<SourceRow>(
      `SELECT ${sourceColumns} FROM ordering_evidence_window_sources
       WHERE window_id = $1 AND sub_invocation = $2 FOR UPDATE`,
      [source.windowId, source.subInvocation],
    );
    const current = locked.rows[0] ? mapSource(locked.rows[0]) : null;
    if (!current) return null;
    if (current.terminalReport !== null) return current.terminalReport as EvidenceWindowSourceReport;
    if (current.creatorState !== "closed") return observeEvidenceWindowSource(client, input.sourceIdentity, actions);
    const latest = await readFacts(client, current);
    if (
      latest.corrupt ||
      latest.purchaseClaims.some((claim) => claim.status !== "released") ||
      latest.capacityClaims.some((claim) => claim.status !== "released") ||
      JSON.stringify(latest.orderIds) !== JSON.stringify(facts.orderIds)
    )
      return observeEvidenceWindowSource(client, input.sourceIdentity, actions);
    const latestObservation = await observeEvidenceWindowSource(client, input.sourceIdentity, actions);
    if (
      !latestObservation ||
      latestObservation.outcome === "unknown" ||
      latestObservation.surfaces.purchaseLimits !== "discharged" ||
      !["discharged", "discharged-with-bounded-usage-residue"].includes(latestObservation.surfaces.usage) ||
      latestObservation.surfaces.capacityAndSellerSignals !== "discharged" ||
      !["discharged", "not-created"].includes(latestObservation.surfaces.orderStreams)
    ) {
      return latestObservation;
    }
    const report: EvidenceWindowSourceReport = {
      ...latestObservation,
      outcome: latestObservation.purchaseLimitResidue.length ? "discharged-with-bounded-usage-residue" : "discharged",
      surfaces: { ...latestObservation.surfaces, sourceClaim: "discharged" },
    };
    const updated = await client.query(
      `UPDATE ordering_evidence_window_sources
       SET discharged_at = now(), terminal_report = $3::jsonb, version = version + 1
       WHERE window_id = $1 AND sub_invocation = $2 AND creator_state = 'closed'
         AND discharged_at IS NULL AND version = $4`,
      [source.windowId, source.subInvocation, JSON.stringify(report), current.version],
    );
    if (updated.rowCount !== 1) return observeEvidenceWindowSource(client, input.sourceIdentity, actions);
    await client.query(
      `DELETE FROM ordering_order_source_claims
       WHERE source_type = $1 AND source_reference_id = $2 AND buyer_account_id = $3`,
      [input.sourceIdentity.sourceType, input.sourceIdentity.sourceReferenceId, input.sourceIdentity.buyerAccountId],
    );
    return report;
  });
}
