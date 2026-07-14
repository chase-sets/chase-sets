import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId, type AccountId } from "@chase-sets/primitives/typed-ids";
import { SavedListConcurrencyConflictError, type SavedListServices } from "./runtime";
import {
  savedListLimits,
  type SavedListCommandId,
  type SavedListCommandResult,
  type SavedListId,
  type SavedListLineId,
  type SavedListProductCatalog,
  type SavedListProductSelection,
} from "../domain/contracts";
import { listRecentSavedLists } from "../read-model/picker-queries";
import type {
  AddProductToSavedListRequest,
  AnonymousSavedListClaimPreparation,
  AnonymousSavedListIntent,
  CreateAnonymousSavedListIntentRequest,
  SavedListAdditionResponse,
  SavedListAdditionTokens,
  SavedListDestination,
  SavedListDiscoverySurface,
} from "./discovery-contracts";

const ANONYMOUS_SAVED_LIST_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_ACTIVE_ANONYMOUS_SAVED_LIST_INTENTS = 20;

export type SavedListDiscoveryErrorCode =
  | "invalid-request"
  | "invalid-product"
  | "product-retired"
  | "product-not-found"
  | "catalog-unavailable"
  | "list-not-found"
  | "list-unavailable"
  | "intent-not-found"
  | "intent-expired"
  | "intent-already-claimed"
  | "intent-limit-reached";

export class SavedListDiscoveryError extends Error {
  constructor(
    readonly code: SavedListDiscoveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SavedListDiscoveryError";
  }
}

type AnonymousIntentRow = Readonly<{
  intent_id: string;
  anonymous_owner_id: string;
  source_path: string;
  source_surface: SavedListDiscoverySurface;
  catalog_catalog_item_id: string;
  product_id: string;
  selected_options: unknown;
  product_summary: string | null;
  add_command_id: string;
  line_id: string;
  status: AnonymousSavedListIntent["status"];
  claimed_account_id: string | null;
  claimed_list_id: string | null;
  claimed_create_command_id: string | null;
  claimed_list_title: string | null;
  claimed_tracked_quantity: number | null;
  claimed_expected_version: number | null;
  claimed_response: unknown | null;
  claimed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}>;

export type SavedListDiscoveryServices = ReturnType<typeof createSavedListDiscoveryRuntime>;

export function createSavedListAdditionTokens(): SavedListAdditionTokens {
  return {
    addCommandId: createId("slc") as SavedListCommandId,
    lineId: createId("sll") as SavedListLineId,
    newListId: createId("svl") as SavedListId,
    newListCommandId: createId("slc") as SavedListCommandId,
  };
}

export function createSavedListDiscoveryRuntime(
  deps: Readonly<{
    db: PgQueryable;
    savedLists: SavedListServices;
    productCatalog: SavedListProductCatalog;
    clock?: () => Date;
  }>,
) {
  const now = deps.clock ?? (() => new Date());

  async function expireAnonymousIntents(anonymousOwnerId: string) {
    await deps.db.query(
      `UPDATE collections_anonymous_saved_list_intents
       SET status = 'expired', updated_at = now()
       WHERE anonymous_owner_id = $1
         AND status = 'active'
         AND expires_at <= now()`,
      [anonymousOwnerId],
    );
  }

  async function getIntent(anonymousOwnerId: string, intentId: string) {
    const ownerId = normalizeAnonymousOwnerId(anonymousOwnerId);
    await expireAnonymousIntents(ownerId);
    const result = await deps.db.query<AnonymousIntentRow>(
      `SELECT *
       FROM collections_anonymous_saved_list_intents
       WHERE intent_id = $1 AND anonymous_owner_id = $2`,
      [normalizeRequired(intentId, "Saved List intent is required."), ownerId],
    );
    const row = result.rows[0];
    return row
      ? {
          intent: toIntent(row),
          expectedVersion: row.claimed_expected_version === null ? null : Number(row.claimed_expected_version),
          response: parseClaimedResponse(row.claimed_response),
        }
      : null;
  }

  async function validateProduct(product: SavedListProductSelection) {
    const normalized = normalizeProduct(product);
    let result: Awaited<ReturnType<SavedListProductCatalog["resolveProduct"]>>;
    try {
      result = await deps.productCatalog.resolveProduct(normalized);
    } catch {
      throw new SavedListDiscoveryError("catalog-unavailable", "Catalog Product validation is unavailable.");
    }
    if (result.availability === "missing") {
      throw new SavedListDiscoveryError("product-not-found", "Product was not found in Catalog.");
    }
    if (result.availability === "retired") {
      throw new SavedListDiscoveryError("product-retired", "Retired Products cannot be added to a Saved List.");
    }
    if (result.availability !== "active") {
      throw new SavedListDiscoveryError("catalog-unavailable", "Catalog Product validation is unavailable.");
    }
    if (!result.product) {
      throw new SavedListDiscoveryError("invalid-product", "Catalog rejected this Product selection.");
    }
    const resolved = normalizeProduct(result.product);
    if (stableProductKey(resolved) !== stableProductKey(normalized)) {
      throw new SavedListDiscoveryError("invalid-product", "Catalog resolved a different Product selection.");
    }
    return resolved;
  }

  async function performAddition(
    input: AddProductToSavedListRequest & Readonly<{ ownerAccountId: AccountId }>,
    context: EventStoreContext,
    guestClaim = false,
    retry?: Readonly<{
      expectedVersion: number | null;
      rememberExpectedVersion: (version: number) => Promise<void>;
    }>,
  ): Promise<SavedListAdditionResponse> {
    const product = await validateProduct(input.product);
    const trackedQuantity = normalizeTrackedQuantity(input.trackedQuantity);
    let listTitle: string;

    if (input.destination.kind === "new") {
      listTitle = normalizeTitle(input.destination.title);
      await deps.savedLists.createSavedList(
        {
          commandId: input.destination.createCommandId,
          listId: input.destination.listId,
          ownerAccountId: input.ownerAccountId,
          title: listTitle,
        },
        context,
      );
    } else {
      const snapshot = await deps.savedLists.getOwnerSnapshot(
        { listId: input.destination.listId, ownerAccountId: input.ownerAccountId },
        context,
      );
      if (!snapshot || snapshot.lifecycle !== "active") {
        throw new SavedListDiscoveryError("list-not-found", "Saved List was not found.");
      }
      listTitle = snapshot.title;
    }

    const command = await applyAdditionWithRetry(
      {
        ownerAccountId: input.ownerAccountId,
        listId: input.destination.listId,
        commandId: input.addCommandId,
        lineId: input.lineId,
        product,
        trackedQuantity,
      },
      context,
      retry,
    );
    const lineResult = command.receipt.lineResults[0];
    if (!lineResult || (lineResult.status !== "added" && lineResult.status !== "merged")) {
      throw new SavedListDiscoveryError(
        "list-unavailable",
        lineResult?.error?.message ?? "Product could not be added to the Saved List.",
      );
    }

    return {
      command,
      listId: input.destination.listId,
      title: listTitle,
      lineStatus: lineResult.status,
      alreadyClaimed: false,
      analyticsLabel: guestClaim
        ? "saved-list.guest-intent-claimed"
        : input.destination.kind === "new"
          ? "saved-list.created-and-added"
          : lineResult.status === "merged"
            ? "saved-list.merged"
            : "saved-list.added",
    };
  }

  async function applyAdditionWithRetry(
    input: Readonly<{
      ownerAccountId: AccountId;
      listId: SavedListId;
      commandId: SavedListCommandId;
      lineId: SavedListLineId;
      product: SavedListProductSelection;
      trackedQuantity: number;
    }>,
    context: EventStoreContext,
    retry?: Readonly<{
      expectedVersion: number | null;
      rememberExpectedVersion: (version: number) => Promise<void>;
    }>,
  ): Promise<SavedListCommandResult> {
    let snapshot = await deps.savedLists.getOwnerSnapshot(
      { listId: input.listId, ownerAccountId: input.ownerAccountId },
      context,
    );
    if (!snapshot || snapshot.lifecycle !== "active") {
      throw new SavedListDiscoveryError("list-not-found", "Saved List was not found.");
    }

    let expectedVersion = retry?.expectedVersion ?? snapshot.version;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await retry?.rememberExpectedVersion(expectedVersion);
      try {
        return await deps.savedLists.applyLineChanges(
          {
            commandId: input.commandId,
            listId: input.listId,
            ownerAccountId: input.ownerAccountId,
            expectedVersion,
            operations: [
              {
                operationId: "discovery-add",
                kind: "add",
                lineId: input.lineId,
                product: input.product,
                trackedQuantity: input.trackedQuantity,
              },
            ],
          },
          context,
        );
      } catch (error) {
        if (!(error instanceof SavedListConcurrencyConflictError) || attempt === 1) {
          throw error;
        }
        snapshot = error.savedList;
        expectedVersion = snapshot.version;
      }
    }
    throw new SavedListDiscoveryError("list-unavailable", "Saved List could not be updated.");
  }

  return {
    listRecent: (ownerAccountId: AccountId) => listRecentSavedLists(deps.db, { ownerAccountId }),
    addProduct: (
      input: AddProductToSavedListRequest & Readonly<{ ownerAccountId: AccountId }>,
      context: EventStoreContext,
    ) => performAddition(input, context),
    async createAnonymousIntent(input: CreateAnonymousSavedListIntentRequest & Readonly<{ anonymousOwnerId: string }>) {
      const anonymousOwnerId = normalizeAnonymousOwnerId(input.anonymousOwnerId);
      const sourcePath = normalizeSourcePath(input.sourcePath);
      const sourceSurface = normalizeSurface(input.sourceSurface);
      const product = await validateProduct(input.product);
      const productSummary = normalizeOptional(input.productSummary);
      await expireAnonymousIntents(anonymousOwnerId);

      const existing = await deps.db.query<AnonymousIntentRow>(
        `SELECT *
         FROM collections_anonymous_saved_list_intents
         WHERE anonymous_owner_id = $1
           AND status = 'active'
           AND expires_at > now()
           AND catalog_catalog_item_id = $2
           AND product_id = $3
           AND selected_options = $4::jsonb
         ORDER BY updated_at DESC
         LIMIT 1`,
        [anonymousOwnerId, product.catalogItemId, product.productId, JSON.stringify(product.selectedOptions)],
      );
      const expiresAt = new Date(now().getTime() + ANONYMOUS_SAVED_LIST_TTL_MS).toISOString();

      if (existing.rows[0]) {
        const updated = await deps.db.query<AnonymousIntentRow>(
          `UPDATE collections_anonymous_saved_list_intents
           SET source_path = $2,
               source_surface = $3,
               product_summary = $4,
               expires_at = $5,
               updated_at = now()
           WHERE intent_id = $1
           RETURNING *`,
          [existing.rows[0].intent_id, sourcePath, sourceSurface, productSummary, expiresAt],
        );
        return toIntent(updated.rows[0]);
      }

      const count = await deps.db.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM collections_anonymous_saved_list_intents
         WHERE anonymous_owner_id = $1 AND status = 'active' AND expires_at > now()`,
        [anonymousOwnerId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= MAX_ACTIVE_ANONYMOUS_SAVED_LIST_INTENTS) {
        throw new SavedListDiscoveryError(
          "intent-limit-reached",
          "Too many Saved List additions are waiting. Finish registration before saving another Product.",
        );
      }

      const tokens = createSavedListAdditionTokens();
      const inserted = await deps.db.query<AnonymousIntentRow>(
        `INSERT INTO collections_anonymous_saved_list_intents (
           intent_id,
           anonymous_owner_id,
           source_path,
           source_surface,
           catalog_catalog_item_id,
           product_id,
           selected_options,
           product_summary,
           add_command_id,
           line_id,
           expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
         RETURNING *`,
        [
          createId("sli"),
          anonymousOwnerId,
          sourcePath,
          sourceSurface,
          product.catalogItemId,
          product.productId,
          JSON.stringify(product.selectedOptions),
          productSummary,
          tokens.addCommandId,
          tokens.lineId,
          expiresAt,
        ],
      );
      return toIntent(inserted.rows[0]);
    },
    async prepareAnonymousClaim(
      input: Readonly<{
        anonymousOwnerId: string;
        intentId: string;
        accountId: AccountId;
      }>,
    ): Promise<AnonymousSavedListClaimPreparation> {
      const loaded = await getIntent(input.anonymousOwnerId, input.intentId);
      if (!loaded) {
        throw new SavedListDiscoveryError("intent-not-found", "Saved List addition was not found.");
      }
      const { intent } = loaded;
      if (intent.status === "expired") {
        throw new SavedListDiscoveryError("intent-expired", "Saved List addition expired. Save the Product again.");
      }
      if (intent.claimedAccountId && intent.claimedAccountId !== input.accountId) {
        throw new SavedListDiscoveryError("intent-already-claimed", "Saved List addition is no longer available.");
      }

      const generated = createSavedListAdditionTokens();
      const resumeDestination = claimedDestination(intent);
      return {
        intent,
        recentLists: await listRecentSavedLists(deps.db, { ownerAccountId: input.accountId }),
        tokens: {
          addCommandId: intent.addCommandId,
          lineId: intent.lineId,
          newListId: resumeDestination?.listId ?? generated.newListId,
          newListCommandId:
            resumeDestination?.kind === "new" ? resumeDestination.createCommandId : generated.newListCommandId,
        },
        resumeDestination,
      };
    },
    async claimAnonymousIntent(
      input: Readonly<{
        anonymousOwnerId: string;
        intentId: string;
        accountId: AccountId;
        destination: SavedListDestination;
        trackedQuantity: number;
        sourceSurface: SavedListDiscoverySurface;
      }>,
      context: EventStoreContext,
    ) {
      const loaded = await getIntent(input.anonymousOwnerId, input.intentId);
      if (!loaded) {
        throw new SavedListDiscoveryError("intent-not-found", "Saved List addition was not found.");
      }
      const { intent } = loaded;
      if (intent.status === "expired") {
        throw new SavedListDiscoveryError("intent-expired", "Saved List addition expired. Save the Product again.");
      }
      if (intent.claimedAccountId && intent.claimedAccountId !== input.accountId) {
        throw new SavedListDiscoveryError("intent-already-claimed", "Saved List addition is no longer available.");
      }

      const trackedQuantity = normalizeTrackedQuantity(input.trackedQuantity);
      const destination = normalizeDestination(input.destination);
      if (intent.status !== "active") {
        assertMatchingClaim(intent, input.accountId, destination, trackedQuantity);
      }
      if (intent.status === "claimed" && loaded.response) {
        return replayClaimedResponse(loaded.response);
      }
      if (destination.kind === "existing") {
        const target = await deps.savedLists.getOwnerSnapshot(
          { listId: destination.listId, ownerAccountId: input.accountId },
          context,
        );
        if (!target || target.lifecycle !== "active") {
          throw new SavedListDiscoveryError("list-not-found", "Saved List was not found.");
        }
      } else {
        normalizeTitle(destination.title);
      }
      await validateProduct(intent.product);

      if (intent.status === "active") {
        const reserved = await deps.db.query<AnonymousIntentRow>(
          `UPDATE collections_anonymous_saved_list_intents
           SET status = 'claiming',
               claimed_account_id = $3,
               claimed_list_id = $4,
               claimed_create_command_id = $5,
               claimed_list_title = $6,
               claimed_tracked_quantity = $7,
               updated_at = now()
           WHERE intent_id = $1
             AND anonymous_owner_id = $2
             AND status = 'active'
             AND expires_at > now()
           RETURNING *`,
          [
            intent.intentId,
            intent.anonymousOwnerId,
            input.accountId,
            destination.listId,
            destination.kind === "new" ? destination.createCommandId : null,
            destination.kind === "new" ? destination.title : null,
            trackedQuantity,
          ],
        );
        if (!reserved.rows[0]) {
          throw new SavedListDiscoveryError("intent-already-claimed", "Saved List addition is no longer available.");
        }
      }

      const addition = await performAddition(
        {
          ownerAccountId: input.accountId,
          destination,
          addCommandId: intent.addCommandId,
          lineId: intent.lineId,
          product: intent.product,
          trackedQuantity,
          sourceSurface: normalizeSurface(input.sourceSurface),
        },
        context,
        true,
        {
          expectedVersion: loaded.expectedVersion,
          rememberExpectedVersion: async (version) => {
            await deps.db.query(
              `UPDATE collections_anonymous_saved_list_intents
               SET claimed_expected_version = $5, updated_at = now()
               WHERE intent_id = $1
                 AND anonymous_owner_id = $2
                 AND claimed_account_id = $3
                 AND claimed_list_id = $4
                 AND status = 'claiming'`,
              [intent.intentId, intent.anonymousOwnerId, input.accountId, destination.listId, version],
            );
          },
        },
      );
      await deps.db.query(
        `UPDATE collections_anonymous_saved_list_intents
         SET status = 'claimed',
             claimed_response = $5::jsonb,
             claimed_at = COALESCE(claimed_at, now()),
             updated_at = now()
         WHERE intent_id = $1
           AND anonymous_owner_id = $2
           AND claimed_account_id = $3
           AND claimed_list_id = $4`,
        [intent.intentId, intent.anonymousOwnerId, input.accountId, destination.listId, JSON.stringify(addition)],
      );
      return addition;
    },
  };
}

function normalizeDestination(destination: SavedListDestination): SavedListDestination {
  const listId = normalizeRequired(destination.listId, "Saved List is required.") as SavedListId;
  return destination.kind === "new"
    ? {
        kind: "new",
        listId,
        createCommandId: normalizeRequired(
          destination.createCommandId,
          "Saved List create command is required.",
        ) as SavedListCommandId,
        title: normalizeTitle(destination.title),
      }
    : { kind: "existing", listId };
}

function claimedDestination(intent: AnonymousSavedListIntent): SavedListDestination | null {
  if (!intent.claimedListId) return null;
  return intent.claimedCreateCommandId && intent.claimedListTitle
    ? {
        kind: "new",
        listId: intent.claimedListId,
        createCommandId: intent.claimedCreateCommandId,
        title: intent.claimedListTitle,
      }
    : { kind: "existing", listId: intent.claimedListId };
}

function assertMatchingClaim(
  intent: AnonymousSavedListIntent,
  accountId: AccountId,
  destination: SavedListDestination,
  trackedQuantity: number,
) {
  const existing = claimedDestination(intent);
  const matches =
    intent.claimedAccountId === accountId &&
    existing?.kind === destination.kind &&
    existing?.listId === destination.listId &&
    intent.claimedTrackedQuantity === trackedQuantity &&
    (existing?.kind !== "new" ||
      (destination.kind === "new" &&
        existing.createCommandId === destination.createCommandId &&
        existing.title === destination.title));
  if (!matches) {
    throw new SavedListDiscoveryError("intent-already-claimed", "Saved List addition is already being claimed.");
  }
}

function parseClaimedResponse(value: unknown): SavedListAdditionResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<SavedListAdditionResponse>;
  return candidate.command && candidate.listId && candidate.title ? (candidate as SavedListAdditionResponse) : null;
}

function replayClaimedResponse(response: SavedListAdditionResponse): SavedListAdditionResponse {
  return {
    ...response,
    alreadyClaimed: true,
    analyticsLabel: "saved-list.guest-intent-claimed",
    command: {
      ...response.command,
      receipt: { ...response.command.receipt, replayed: true },
    },
  };
}

function toIntent(row: AnonymousIntentRow): AnonymousSavedListIntent {
  return {
    intentId: row.intent_id,
    anonymousOwnerId: row.anonymous_owner_id,
    sourcePath: row.source_path,
    sourceSurface: row.source_surface,
    product: normalizeProduct({
      catalogItemId: row.catalog_catalog_item_id as SavedListProductSelection["catalogItemId"],
      productId: row.product_id as SavedListProductSelection["productId"],
      selectedOptions: Array.isArray(row.selected_options)
        ? (row.selected_options as SavedListProductSelection["selectedOptions"])
        : [],
    }),
    productSummary: row.product_summary,
    addCommandId: row.add_command_id as SavedListCommandId,
    lineId: row.line_id as SavedListLineId,
    status: row.status,
    claimedAccountId: row.claimed_account_id as AccountId | null,
    claimedListId: row.claimed_list_id as SavedListId | null,
    claimedCreateCommandId: row.claimed_create_command_id as SavedListCommandId | null,
    claimedListTitle: row.claimed_list_title,
    claimedTrackedQuantity: row.claimed_tracked_quantity === null ? null : Number(row.claimed_tracked_quantity),
    claimedAt: toIso(row.claimed_at),
    expiresAt: toIso(row.expires_at)!,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function normalizeProduct(product: SavedListProductSelection): SavedListProductSelection {
  return {
    catalogItemId: normalizeRequired(
      product.catalogItemId,
      "Catalog Item is required.",
    ) as SavedListProductSelection["catalogItemId"],
    productId: normalizeRequired(product.productId, "Product is required.") as SavedListProductSelection["productId"],
    selectedOptions: [...(product.selectedOptions ?? [])]
      .map((option) => ({
        dimensionId: normalizeRequired(option.dimensionId, "Product Option dimension is required."),
        optionId: normalizeRequired(option.optionId, "Product Option is required."),
      }))
      .sort((left, right) =>
        left.dimensionId === right.dimensionId
          ? left.optionId.localeCompare(right.optionId)
          : left.dimensionId.localeCompare(right.dimensionId),
      ),
  };
}

function stableProductKey(product: SavedListProductSelection) {
  return JSON.stringify(normalizeProduct(product));
}

function normalizeTrackedQuantity(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > savedListLimits.maximumTrackedQuantity) {
    throw new SavedListDiscoveryError("invalid-request", "Tracked Quantity must be a supported positive whole number.");
  }
  return value;
}

function normalizeTitle(value: string) {
  const title = normalizeRequired(value, "Saved List title is required.");
  if (title.length > savedListLimits.maximumTitleLength) {
    throw new SavedListDiscoveryError("invalid-request", "Saved List title is too long.");
  }
  return title;
}

function normalizeSourcePath(value: string) {
  const path = normalizeRequired(value, "Saved List source path is required.");
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 2_000) {
    throw new SavedListDiscoveryError("invalid-request", "Saved List source path is invalid.");
  }
  return path;
}

function normalizeSurface(value: SavedListDiscoverySurface) {
  if (value !== "search" && value !== "item-detail") {
    throw new SavedListDiscoveryError("invalid-request", "Saved List source surface is invalid.");
  }
  return value;
}

function normalizeAnonymousOwnerId(value: string) {
  const ownerId = normalizeRequired(value, "Anonymous Saved List owner is required.");
  if (!ownerId.startsWith("anon_")) {
    throw new SavedListDiscoveryError("invalid-request", "Anonymous Saved List owner is invalid.");
  }
  return ownerId;
}

function normalizeOptional(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized.slice(0, 500) : null;
}

function normalizeRequired(value: unknown, message: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new SavedListDiscoveryError("invalid-request", message);
  return normalized;
}

function toIso(value: string | null) {
  return value === null ? null : new Date(value).toISOString();
}
