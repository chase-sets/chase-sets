import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { OfferId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceOfferServices } from "../api/runtime";

type Work = {
  workId: string;
  catalogItemId: string;
  productId: string;
  afterOfferId: string;
  status: "pending" | "claimed" | "completed";
  availableAt: string;
  kind?: "reaction" | "recovery";
};
function conflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}

export function createManagedOfferWork(deps: {
  eventStore: EventStore;
  db: PgQueryable;
  offers: Pick<MarketplaceOfferServices, "applyManagedOfferPage">;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  async function enqueue(
    product: { catalogItemId: string; productId: string },
    identity: string,
    context: EventStoreContext,
    kind: "reaction" | "recovery" = "reaction",
  ) {
    const workId = createHash("sha256")
      .update(JSON.stringify([product, identity]))
      .digest("hex");
    try {
      await deps.eventStore.appendToStream({
        streamId: `marketplace.offer-work-${workId}`,
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "marketplace.offer.work-requested",
            payload: {
              ...product,
              kind,
              workId,
              afterOfferId: "",
              status: "pending",
              availableAt: now().toISOString(),
            },
          },
        ],
      });
    } catch (error) {
      if (!conflict(error)) throw error;
    }
    return workId;
  }
  async function run(context: EventStoreContext) {
    const candidates = await deps.db.query<{ work_id: string; last_stream_version: number }>(
      `SELECT work_id, last_stream_version FROM marketplace_managed_offer_work
      WHERE status <> 'completed' AND available_at <= $1 ORDER BY kind, available_at, work_id LIMIT 1`,
      [now().toISOString()],
    );
    const workId = candidates.rows[0]?.work_id;
    if (!workId) return 0;
    const streamId = `marketplace.offer-work-${workId}`;
    const latest = (
      await readCompleteStream(deps.eventStore, {
        streamId,
        fromVersion: candidates.rows[0]!.last_stream_version,
      })
    ).at(-1);
    if (!latest) return 0;
    const work = latest.payload as Work;
    if (work.status === "completed" || Date.parse(work.availableAt) > now().getTime()) return 0;
    const claim: Work = { ...work, status: "claimed", availableAt: new Date(now().getTime() + 60_000).toISOString() };
    try {
      await deps.eventStore.appendToStream({
        streamId,
        expectedVersion: latest.streamVersion,
        context,
        events: [{ eventType: "marketplace.offer.work-claimed", payload: claim }],
      });
    } catch (error) {
      if (conflict(error)) return 0;
      throw error;
    }
    const claimVersion = latest.streamVersion + 1;
    const page = await deps.db.query<{ offer_id: string }>(
      `SELECT offer.offer_id FROM marketplace_offer_pages AS offer
      JOIN marketplace_buyer_offer_policy_memberships AS membership ON membership.offer_id = offer.offer_id
      JOIN marketplace_buyer_offer_policy_pages AS policy ON policy.policy_id = membership.policy_id
      WHERE offer.catalog_catalog_item_id = $1 AND offer.product_id = $2 AND offer.status = 'submitted'
        AND policy.state->>'status' = 'active' AND offer.offer_id > $3
      ORDER BY offer.offer_id LIMIT 100`,
      [work.catalogItemId, work.productId, work.afterOfferId],
    );
    await deps.offers.applyManagedOfferPage(
      page.rows.map((row) => ({ offerId: row.offer_id as OfferId, operationId: `${workId}_${row.offer_id}` })),
      context,
      { streamId, expectedVersion: claimVersion, context, events: [] },
    );
    await deps.eventStore.appendToStream({
      streamId,
      expectedVersion: claimVersion,
      context,
      events: [
        {
          eventType: "marketplace.offer.work-progressed",
          payload: {
            ...work,
            afterOfferId: page.rows.at(-1)?.offer_id ?? work.afterOfferId,
            status: page.rows.length === 100 ? "pending" : "completed",
            availableAt: now().toISOString(),
          },
        },
      ],
    });
    return page.rows.length;
  }
  async function recover(context: EventStoreContext) {
    await deps.db.query(
      "INSERT INTO marketplace_managed_offer_recovery (singleton) VALUES (true) ON CONFLICT DO NOTHING",
    );
    const cursor = await deps.db.query<{ after_offer_id: string; generation: string; pending_work_ids: string[] }>(
      "SELECT after_offer_id, generation::text, pending_work_ids FROM marketplace_managed_offer_recovery WHERE singleton = true",
    );
    const current = cursor.rows[0]!;
    // The cursor's bounded barrier is authoritative even before work projections
    // catch up or after they are rebuilt. Never outrun the previous page's work.
    for (const workId of current.pending_work_ids) {
      const latest = (await readCompleteStream(deps.eventStore, { streamId: `marketplace.offer-work-${workId}` })).at(
        -1,
      );
      if (latest?.payload.status !== "completed") return 0;
    }
    const page = await deps.db.query<{ offer_id: string; catalog_catalog_item_id: string; product_id: string }>(
      `
      SELECT offer.offer_id, offer.catalog_catalog_item_id, offer.product_id FROM marketplace_offer_pages AS offer
      JOIN marketplace_buyer_offer_policy_memberships AS membership ON membership.offer_id = offer.offer_id
      JOIN marketplace_buyer_offer_policy_pages AS policy ON policy.policy_id = membership.policy_id
      WHERE offer.offer_id > $1 AND offer.status = 'submitted' AND policy.state->>'status' = 'active'
      ORDER BY offer.offer_id LIMIT 100`,
      [current.after_offer_id],
    );
    const products = new Map(
      page.rows.map((row) => [JSON.stringify([row.catalog_catalog_item_id, row.product_id]), row]),
    );
    const pendingWorkIds: string[] = [];
    for (const row of products.values()) {
      const pending = await deps.db.query<{ work_id: string }>(
        `SELECT work_id FROM marketplace_managed_offer_work
        WHERE catalog_item_id = $1 AND product_id = $2 AND status <> 'completed' LIMIT 1`,
        [row.catalog_catalog_item_id, row.product_id],
      );
      pendingWorkIds.push(
        pending.rows[0]?.work_id ??
          (await enqueue(
            { catalogItemId: row.catalog_catalog_item_id, productId: row.product_id },
            `recovery_${current.generation}`,
            context,
            "recovery",
          )),
      );
    }
    await deps.db.query(
      `UPDATE marketplace_managed_offer_recovery SET after_offer_id = $1,
        generation = generation + $4, pending_work_ids = $5
      WHERE singleton = true AND after_offer_id = $2 AND generation = $3`,
      [
        page.rows.at(-1)?.offer_id ?? "",
        current.after_offer_id,
        current.generation,
        page.rows.length === 0 ? 1 : 0,
        pendingWorkIds,
      ],
    );
    return page.rows.length;
  }
  return { enqueue, run, recover };
}

export function buildManagedOfferMarketPriceReactions(
  work: Pick<ReturnType<typeof createManagedOfferWork>, "enqueue">,
): ProjectorHandlerMap {
  return {
    "pricing.market-price.estimated": async (event) => {
      if (typeof event.data.catalogItemId !== "string" || typeof event.data.productId !== "string")
        throw new Error("Market Price signal requires an exact Product.");
      await work.enqueue({ catalogItemId: event.data.catalogItemId, productId: event.data.productId }, event.id, {
        tenantId: event.tenantId,
        audit: event.audit,
      });
    },
  };
}
