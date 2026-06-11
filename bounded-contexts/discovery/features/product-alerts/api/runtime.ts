import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import {
  decideProductAlert,
  evolveProductAlert,
  initialProductAlertState,
  productAlertStreamId,
  type ProductAlertCommand,
  type ProductAlertEvent,
  type ProductAlertMarketSide,
  type ProductAlertSelectedOption,
  type ProductAlertState,
} from "../domain/domain";
import { getProductAlert, listProductAlerts, type ProductAlertPageRow } from "../read-model/queries";
import { buildProductAlertPageProjectionHandlers } from "../read-model/projection";
import type {
  AnonymousProductAlertIntent,
  CreateAnonymousProductAlertIntentRequest,
  CreateProductAlertRequest,
} from "./contracts";

const ANONYMOUS_PRODUCT_ALERT_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_ACTIVE_ANONYMOUS_PRODUCT_ALERT_INTENTS = 20;

type AnonymousProductAlertIntentRow = Omit<
  AnonymousProductAlertIntent,
  "catalog_item_id" | "selected_options" | "threshold_amount"
> &
  Readonly<{
    catalog_catalog_item_id: string;
    selected_options: unknown;
    threshold_amount: string | number | null;
  }>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeRequiredText(value: string, message: string) {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeAnonymousOwnerId(value: string) {
  const normalized = normalizeRequiredText(value, "Anonymous Product Alert owner is required.");
  assert(normalized.startsWith("anon_"), "Anonymous Product Alert owner is invalid.");
  return normalized;
}

function normalizeSourcePath(value: string) {
  const normalized = normalizeRequiredText(value, "Product Alert source path is required.");
  assert(normalized.startsWith("/") && !normalized.startsWith("//"), "Product Alert source path is invalid.");
  return normalized;
}

function normalizeMarketSide(value: ProductAlertMarketSide) {
  assert(value === "listing" || value === "offer", "Product Alert market side is invalid.");
  return value;
}

function normalizeOptionalMoney(value: string | null | undefined) {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) {
    return null;
  }

  assert(/^\d+(\.\d{1,2})?$/.test(normalized), "Price threshold must be a valid decimal.");
  return Number.parseFloat(normalized).toFixed(2);
}

function normalizeSelectedOptions(selectedOptions: readonly ProductAlertSelectedOption[]) {
  return [...selectedOptions]
    .map((selection) => ({
      dimensionId: String(selection.dimensionId ?? "").trim(),
      optionId: String(selection.optionId ?? "").trim(),
    }))
    .filter((selection) => selection.dimensionId.length > 0 && selection.optionId.length > 0)
    .sort((left, right) =>
      left.dimensionId === right.dimensionId
        ? left.optionId.localeCompare(right.optionId)
        : left.dimensionId.localeCompare(right.dimensionId),
    );
}

function normalizeAnonymousProductAlertIntentRow(row: AnonymousProductAlertIntentRow): AnonymousProductAlertIntent {
  return {
    intent_id: row.intent_id,
    anonymous_owner_id: row.anonymous_owner_id,
    source_path: row.source_path,
    market_side: row.market_side,
    catalog_item_id: row.catalog_catalog_item_id,
    product_id: row.product_id,
    selected_options: Array.isArray(row.selected_options)
      ? normalizeSelectedOptions(row.selected_options as ProductAlertSelectedOption[])
      : [],
    product_summary: row.product_summary,
    threshold_amount: row.threshold_amount === null ? null : Number(row.threshold_amount).toFixed(2),
    status: row.status,
    claimed_account_id: row.claimed_account_id,
    claimed_alert_id: row.claimed_alert_id,
    claimed_at: row.claimed_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export type ProductAlertServices = Readonly<{
  commandHandler: CommandHandler<ProductAlertCommand, ProductAlertState, ProductAlertEvent>;
  createProductAlert: (
    input: CreateProductAlertRequest & Readonly<{ accountId: string }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ alertId: string; version: number }>>;
  pauseProductAlert: (
    input: Readonly<{ accountId: string; alertId: string }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ alertId: string; version: number }>>;
  resumeProductAlert: (
    input: Readonly<{ accountId: string; alertId: string }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ alertId: string; version: number }>>;
  deleteProductAlert: (
    input: Readonly<{ accountId: string; alertId: string }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ alertId: string; version: number }>>;
  listProductAlerts: (input: Readonly<{ accountId: string }>) => Promise<readonly ProductAlertPageRow[]>;
  getProductAlert: (input: Readonly<{ accountId: string; alertId: string }>) => Promise<ProductAlertPageRow | null>;
  createAnonymousProductAlertIntent: (
    input: CreateAnonymousProductAlertIntentRequest & Readonly<{ anonymousOwnerId: string }>,
  ) => Promise<AnonymousProductAlertIntent>;
  getAnonymousProductAlertIntent: (
    input: Readonly<{ anonymousOwnerId: string; intentId: string }>,
  ) => Promise<AnonymousProductAlertIntent | null>;
  claimAnonymousProductAlertIntent: (
    input: Readonly<{ anonymousOwnerId: string; intentId: string; accountId: string }>,
    context: EventStoreContext,
  ) => Promise<AnonymousProductAlertIntent>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createProductAlertRuntime(deps: DiscoveryRuntimeDeps): ProductAlertServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<ProductAlertEvent>(),
      initialState: () => initialProductAlertState,
      evolve: evolveProductAlert,
    }),
    evolve: evolveProductAlert,
    decide: decideProductAlert,
  });

  async function ensureOwnedAlert(accountId: string, alertId: string) {
    const alert = await getProductAlert(deps.db, { accountId, alertId });
    if (!alert || alert.status === "deleted") {
      throw new Error("Product Alert was not found.");
    }
    return alert;
  }

  async function expireAnonymousProductAlertIntents(anonymousOwnerId: string) {
    await deps.db.query(
      `UPDATE discovery_anonymous_product_alert_intents
       SET status = 'expired', updated_at = now()
       WHERE anonymous_owner_id = $1
         AND status = 'active'
         AND expires_at <= now()`,
      [anonymousOwnerId],
    );
  }

  async function getAnonymousProductAlertIntent(
    input: Readonly<{ anonymousOwnerId: string; intentId: string }>,
  ): Promise<AnonymousProductAlertIntent | null> {
    const anonymousOwnerId = normalizeAnonymousOwnerId(input.anonymousOwnerId);
    await expireAnonymousProductAlertIntents(anonymousOwnerId);

    const result = await deps.db.query<AnonymousProductAlertIntentRow>(
      `SELECT *
       FROM discovery_anonymous_product_alert_intents
       WHERE intent_id = $1
         AND anonymous_owner_id = $2`,
      [input.intentId, anonymousOwnerId],
    );

    return result.rows[0] ? normalizeAnonymousProductAlertIntentRow(result.rows[0]) : null;
  }

  async function createAccountProductAlert(
    input: CreateProductAlertRequest & Readonly<{ accountId: string }>,
    context: EventStoreContext,
  ) {
    return createAccountProductAlertWithId({ ...input, alertId: createId("pal") }, context);
  }

  async function createAccountProductAlertWithId(
    input: CreateProductAlertRequest & Readonly<{ accountId: string; alertId: string }>,
    context: EventStoreContext,
  ) {
    const result = await commandHandler({
      streamId: productAlertStreamId(input.alertId),
      expectedVersion: "no_stream",
      context,
      command: {
        type: "CreateProductAlert",
        alertId: input.alertId,
        accountId: input.accountId,
        marketSide: input.marketSide,
        catalogItemId: input.catalogItemId,
        productId: input.productId,
        selectedOptions: input.selectedOptions ?? [],
        productSummary: input.productSummary ?? null,
        thresholdAmount: input.thresholdAmount ?? null,
      },
    });

    return { alertId: input.alertId, version: result.version };
  }

  async function releaseClaimedAnonymousProductAlertIntent(
    input: Readonly<{ anonymousOwnerId: string; intentId: string; accountId: string; alertId: string }>,
  ) {
    await deps.db.query(
      `UPDATE discovery_anonymous_product_alert_intents
       SET status = 'active',
           claimed_account_id = NULL,
           claimed_alert_id = NULL,
           claimed_at = NULL,
           updated_at = now()
       WHERE intent_id = $1
         AND anonymous_owner_id = $2
         AND status = 'claimed'
         AND claimed_account_id = $3
         AND claimed_alert_id = $4`,
      [input.intentId, input.anonymousOwnerId, input.accountId, input.alertId],
    );
  }

  return {
    commandHandler,
    createProductAlert: createAccountProductAlert,
    async pauseProductAlert(input, context) {
      await ensureOwnedAlert(input.accountId, input.alertId);
      const result = await commandHandler({
        streamId: productAlertStreamId(input.alertId),
        context,
        command: { type: "PauseProductAlert" },
      });

      return { alertId: input.alertId, version: result.version };
    },
    async resumeProductAlert(input, context) {
      await ensureOwnedAlert(input.accountId, input.alertId);
      const result = await commandHandler({
        streamId: productAlertStreamId(input.alertId),
        context,
        command: { type: "ResumeProductAlert" },
      });

      return { alertId: input.alertId, version: result.version };
    },
    async deleteProductAlert(input, context) {
      await ensureOwnedAlert(input.accountId, input.alertId);
      const result = await commandHandler({
        streamId: productAlertStreamId(input.alertId),
        context,
        command: { type: "DeleteProductAlert" },
      });

      return { alertId: input.alertId, version: result.version };
    },
    listProductAlerts: (input) => listProductAlerts(deps.db, input),
    getProductAlert: (input) => getProductAlert(deps.db, input),
    async createAnonymousProductAlertIntent(input) {
      const anonymousOwnerId = normalizeAnonymousOwnerId(input.anonymousOwnerId);
      const sourcePath = normalizeSourcePath(input.sourcePath);
      const marketSide = normalizeMarketSide(input.marketSide);
      const catalogItemId = normalizeRequiredText(input.catalogItemId, "Product Alert requires a Catalog Item.");
      const productId = normalizeRequiredText(input.productId, "Product Alert requires a Product.");
      const selectedOptions = normalizeSelectedOptions(input.selectedOptions ?? []);
      const productSummary = normalizeOptionalText(input.productSummary);
      const thresholdAmount = normalizeOptionalMoney(input.thresholdAmount);

      await expireAnonymousProductAlertIntents(anonymousOwnerId);

      const existingResult = await deps.db.query<AnonymousProductAlertIntentRow>(
        `SELECT *
         FROM discovery_anonymous_product_alert_intents
         WHERE anonymous_owner_id = $1
           AND status = 'active'
           AND expires_at > now()
           AND market_side = $2
           AND catalog_catalog_item_id = $3
           AND product_id = $4
           AND selected_options = $5::jsonb
           AND threshold_amount IS NOT DISTINCT FROM $6::numeric
         ORDER BY updated_at DESC
         LIMIT 1`,
        [anonymousOwnerId, marketSide, catalogItemId, productId, JSON.stringify(selectedOptions), thresholdAmount],
      );

      const expiresAt = new Date(Date.now() + ANONYMOUS_PRODUCT_ALERT_TTL_MS).toISOString();

      if (existingResult.rows[0]) {
        const result = await deps.db.query<AnonymousProductAlertIntentRow>(
          `UPDATE discovery_anonymous_product_alert_intents
           SET source_path = $2,
               product_summary = $3,
               expires_at = $4,
               updated_at = now()
           WHERE intent_id = $1
           RETURNING *`,
          [existingResult.rows[0].intent_id, sourcePath, productSummary, expiresAt],
        );

        return normalizeAnonymousProductAlertIntentRow(result.rows[0]);
      }

      const countResult = await deps.db.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM discovery_anonymous_product_alert_intents
         WHERE anonymous_owner_id = $1
           AND status = 'active'
           AND expires_at > now()`,
        [anonymousOwnerId],
      );
      assert(
        Number(countResult.rows[0]?.count ?? 0) < MAX_ACTIVE_ANONYMOUS_PRODUCT_ALERT_INTENTS,
        "Too many saved Watch alerts. Finish registration or wait before saving another alert.",
      );

      const result = await deps.db.query<AnonymousProductAlertIntentRow>(
        `INSERT INTO discovery_anonymous_product_alert_intents (
           intent_id,
           anonymous_owner_id,
           source_path,
           market_side,
           catalog_catalog_item_id,
           product_id,
           selected_options,
           product_summary,
           threshold_amount,
           expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::numeric, $10)
         RETURNING *`,
        [
          createId("pai"),
          anonymousOwnerId,
          sourcePath,
          marketSide,
          catalogItemId,
          productId,
          JSON.stringify(selectedOptions),
          productSummary,
          thresholdAmount,
          expiresAt,
        ],
      );

      return normalizeAnonymousProductAlertIntentRow(result.rows[0]);
    },
    getAnonymousProductAlertIntent,
    async claimAnonymousProductAlertIntent(input, context) {
      const anonymousOwnerId = normalizeAnonymousOwnerId(input.anonymousOwnerId);
      const accountId = normalizeRequiredText(input.accountId, "Product Alert account is required.");
      await expireAnonymousProductAlertIntents(anonymousOwnerId);

      const existing = await getAnonymousProductAlertIntent({
        anonymousOwnerId,
        intentId: input.intentId,
      });
      assert(existing, "Watch alert was not found. Start a new alert from the item page.");

      if (existing.status === "claimed" && existing.claimed_account_id === accountId) {
        return existing;
      }

      assert(existing.status === "active", "Watch alert is no longer available. Start a new alert from the item page.");

      const alertId = createId("pal");

      const result = await deps.db.query<AnonymousProductAlertIntentRow>(
        `UPDATE discovery_anonymous_product_alert_intents
         SET status = 'claimed',
             claimed_account_id = $3,
             claimed_alert_id = $4,
             claimed_at = now(),
             updated_at = now()
         WHERE intent_id = $1
           AND anonymous_owner_id = $2
           AND status = 'active'
           AND expires_at > now()
         RETURNING *`,
        [input.intentId, anonymousOwnerId, accountId, alertId],
      );

      assert(result.rows[0], "Watch alert is no longer available. Start a new alert from the item page.");

      const claimed = normalizeAnonymousProductAlertIntentRow(result.rows[0]);
      try {
        await createAccountProductAlertWithId(
          {
            alertId,
            accountId,
            marketSide: claimed.market_side,
            catalogItemId: claimed.catalog_item_id,
            productId: claimed.product_id,
            selectedOptions: claimed.selected_options,
            productSummary: claimed.product_summary,
            thresholdAmount: claimed.threshold_amount,
          },
          context,
        );
      } catch (error) {
        await releaseClaimedAnonymousProductAlertIntent({
          anonymousOwnerId,
          intentId: input.intentId,
          accountId,
          alertId,
        });
        throw error;
      }

      return claimed;
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "discovery-product-alert-page-projection",
        handlers: buildProductAlertPageProjectionHandlers(deps.db),
      }),
    ],
  };
}
