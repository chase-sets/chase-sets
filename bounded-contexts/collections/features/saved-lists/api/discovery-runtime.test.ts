import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type {
  SavedListCommandId,
  SavedListId,
  SavedListLineId,
  SavedListProductCatalog,
  SavedListProductSelection,
} from "../domain/contracts";
import { createSavedListRuntime } from "./runtime";
import {
  createSavedListAdditionTokens,
  createSavedListDiscoveryRuntime,
  SavedListDiscoveryError,
} from "./discovery-runtime";

const ownerAccountId = "acc_owner" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_owner" as never, forAccountId: ownerAccountId },
};
const now = "2026-07-13T12:00:00.000Z";

function product(value = "card"): SavedListProductSelection {
  const catalogItemId = `cat_${value}` as CatalogItemId;
  return {
    catalogItemId,
    productId: `${catalogItemId}::condition:near-mint` as ProductKey,
    selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
  };
}

function setup(db: PgQueryable = emptyDb()) {
  const store = createInMemoryEventStore();
  const productCatalog: SavedListProductCatalog = {
    resolveProduct: vi.fn<SavedListProductCatalog["resolveProduct"]>(async (selection) => ({
      availability: "active",
      product: selection,
    })),
  };
  const savedLists = createSavedListRuntime({
    eventStore: store.eventStore,
    productCatalog,
    clock: () => now,
  });
  return {
    savedLists,
    allEvents: store.allEvents,
    discovery: createSavedListDiscoveryRuntime({
      db,
      savedLists,
      productCatalog,
      clock: () => new Date(now),
    }),
  };
}

describe("REVIEW-PROBE-9471", () => {
  it("P2 deterministic interleave: concurrent same-owner refresh before our refresh UPDATE", async () => {
    const memory = createIntentDb();
    memory.insertIntent({ intentId: "sli_existing" });
    let interleaved = false;
    const db: PgQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        if (!interleaved && sql.includes("SET source_path")) {
          interleaved = true;
          const row = memory.intents.get("sli_existing")!;
          row.owner_revision = Number(row.owner_revision) + 1;
        }
        return memory.db.query<Row>(sql, values);
      },
    };
    const { discovery } = setup(db);
    const outcome = await discovery
      .createAnonymousIntent({
        anonymousOwnerId: "anon_device",
        sourcePath: "/search",
        sourceSurface: "search",
        product: product(),
      })
      .then(
        (intent) => ({ ok: intent.intentId }),
        (error: { code?: string }) => ({ err: error.code }),
      );
    expect(outcome).toEqual({ ok: "sli_existing" });
    expect(memory.intents.get("sli_existing")).toMatchObject({
      status: "active",
      owner_revision: 2,
      anonymous_owner_id: "anon_device",
    });
  });

  it.each([
    { interleave: "claiming", code: "intent-already-claimed" },
    { interleave: "claimed", code: "intent-already-claimed" },
    { interleave: "expiry", code: "intent-expired" },
    { interleave: "deletion", code: "intent-not-found" },
    { interleave: "different owner", code: "intent-not-found" },
  ])("rejects $interleave on the owner-scoped refresh re-read", async ({ interleave, code }) => {
    const memory = createIntentDb();
    memory.insertIntent({ intentId: "sli_existing" });
    let interleaved = false;
    const db: PgQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        if (!interleaved && sql.includes("SET source_path")) {
          interleaved = true;
          const row = memory.intents.get("sli_existing")!;
          row.owner_revision = Number(row.owner_revision) + 1;
          if (interleave === "claiming" || interleave === "claimed") row.status = interleave;
          if (interleave === "expiry") row.expires_at = now;
          if (interleave === "deletion") memory.intents.delete("sli_existing");
          if (interleave === "different owner") row.anonymous_owner_fingerprint = "other-owner";
        }
        return memory.db.query<Row>(sql, values);
      },
    };
    await expect(
      setup(db).discovery.createAnonymousIntent({
        anonymousOwnerId: "anon_device",
        sourcePath: "/search",
        sourceSurface: "search",
        product: product(),
      }),
    ).rejects.toMatchObject({ code });
  });
});

describe("Saved List discovery application", () => {
  it("reuses a legacy intent with a differently ordered Option array", async () => {
    const memory = createIntentDb();
    memory.insertIntent({ intentId: "sli_reordered" });
    const selection = {
      ...product(),
      selectedOptions: [
        { dimensionId: "B", optionId: "b" },
        { dimensionId: "a", optionId: "a" },
      ],
    };
    memory.intents.get("sli_reordered")!.selected_options = [...selection.selectedOptions].reverse();
    const { discovery } = setup(memory.db);
    const captured = await discovery.createAnonymousIntent({
      anonymousOwnerId: "anon_device",
      sourcePath: "/search",
      sourceSurface: "search",
      product: selection,
    });
    expect(captured.intentId).toBe("sli_reordered");
  });

  it("does not expose a raw secret marker in validation errors", async () => {
    const marker = "anon_SECRET_MARKER_8931\ud800";
    const { discovery } = setup();
    const error = await discovery
      .createAnonymousIntent({
        anonymousOwnerId: marker,
        sourcePath: "/search",
        sourceSurface: "search",
        product: product(),
      })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SavedListDiscoveryError);
    expect((error as Error).message).not.toContain("SECRET_MARKER_8931");
  });
  it("anonymous-owner-mixed-version-compatibility alternate-raw-interface mutant", async () => {
    const memory = createIntentDb();
    const { discovery } = setup(memory.db);
    const intent = await discovery.createAnonymousIntent({
      anonymousOwnerId: "anon_device",
      sourcePath: "/search",
      sourceSurface: "search",
      product: product(),
    });
    expect(intent).not.toHaveProperty("anonymousOwnerId");
    expect(intent).toHaveProperty("anonymousOwnerFingerprint", expect.stringMatching(/^sha256:v1:[a-f0-9]{64}$/));
    expect(JSON.stringify(intent)).not.toContain("anon_device");
    expect(memory.intents.get(intent.intentId)?.anonymous_owner_id).toBe("anon_device");
  });
  it("creates a private List, returns command snapshots, and merges duplicate Product identity", async () => {
    const { discovery } = setup();
    const firstTokens = createSavedListAdditionTokens();
    const { response: first, createReceipt } = await discovery.addProduct(
      {
        ownerAccountId,
        destination: {
          kind: "new",
          listId: firstTokens.newListId,
          createCommandId: firstTokens.newListCommandId,
          title: "Trade targets",
        },
        addCommandId: firstTokens.addCommandId,
        lineId: firstTokens.lineId,
        product: product(),
        trackedQuantity: 2,
        sourceSurface: "search",
      },
      context,
    );

    const secondTokens = createSavedListAdditionTokens();
    const { response: second } = await discovery.addProduct(
      {
        ownerAccountId,
        destination: { kind: "existing", listId: first.listId },
        addCommandId: secondTokens.addCommandId,
        lineId: secondTokens.lineId,
        product: product(),
        trackedQuantity: 3,
        sourceSurface: "item-detail",
      },
      context,
    );

    expect(first).toMatchObject({ lineStatus: "added", analyticsLabel: "saved-list.created-and-added" });
    expect(Object.keys(first).sort()).toEqual(
      ["alreadyClaimed", "analyticsLabel", "command", "lineStatus", "listId", "title"].sort(),
    );
    expect(createReceipt).toMatchObject({ outcome: "created", replayed: false });
    expect(second).toMatchObject({ lineStatus: "merged", analyticsLabel: "saved-list.merged" });
    expect(second.command.savedList).toMatchObject({
      visibility: "private",
      membership: { lineCount: 1, trackedUnitCount: 5 },
      lines: [{ lineId: firstTokens.lineId, trackedQuantity: 5 }],
    });
  });

  it("analytics-guest-response-preserved claims one guest intent idempotently for the same account and destination", async () => {
    const memory = createIntentDb();
    const { discovery, savedLists, allEvents } = setup(memory.db);
    const targetListId = "svl_target" as SavedListId;
    await savedLists.createSavedList(
      {
        commandId: "slc_create_target" as SavedListCommandId,
        listId: targetListId,
        ownerAccountId,
        title: "Favorites",
      },
      context,
    );
    const intent = await discovery.createAnonymousIntent({
      anonymousOwnerId: "anon_device",
      sourcePath: "/search?q=pikachu",
      sourceSurface: "search",
      product: product(),
      productSummary: "Pikachu · Near Mint",
    });
    const claimInput = {
      anonymousOwnerId: "anon_device",
      intentId: intent.intentId,
      accountId: ownerAccountId,
      destination: { kind: "existing" as const, listId: targetListId },
      trackedQuantity: 1,
      sourceSurface: "search" as const,
    };

    const beforeClaimEvents = allEvents.length;
    const first = await runWithEventCommitMetadata(async () => {
      const result = await discovery.claimAnonymousIntent(claimInput, context);
      return { result, metadata: getEventCommitMetadata() };
    });
    const replay = await runWithEventCommitMetadata(async () => {
      const result = await discovery.claimAnonymousIntent(claimInput, context);
      return { result, metadata: getEventCommitMetadata() };
    });

    expect(first.result.alreadyClaimed).toBe(false);
    expect(replay.result).toMatchObject({ alreadyClaimed: true, lineStatus: "added" });
    expect(replay.result.command.receipt.replayed).toBe(true);
    expect(replay.result.command.savedList.membership).toEqual({
      orderedLineIds: [intent.lineId],
      lineCount: 1,
      trackedUnitCount: 1,
    });
    expect(first.metadata.sources).toEqual([
      {
        sourceContextName: "collections",
        eventIds: allEvents.slice(beforeClaimEvents).map((event) => event.eventId),
        maxGlobalPosition: allEvents.at(-1)!.globalPosition,
      },
    ]);
    expect(replay.metadata.eventIds).toEqual([]);
    expect(memory.intents.get(intent.intentId)?.status).toBe("claimed");
    expect(Object.keys(memory.intents.get(intent.intentId)?.claimed_response as object).sort()).toEqual(
      ["alreadyClaimed", "analyticsLabel", "command", "lineStatus", "listId", "title"].sort(),
    );
  });

  it("receipt-only-recovery-poison rejects claimed_response without aggregate authority", async () => {
    const memory = createIntentDb();
    memory.insertIntent({ intentId: "sli_poison" });
    const row = memory.intents.get("sli_poison")!;
    Object.assign(row, {
      status: "claimed",
      claimed_account_id: ownerAccountId,
      claimed_list_id: "svl_poison",
      claimed_tracked_quantity: 1,
      claimed_response: { command: { receipt: { replayed: false } }, listId: "svl_poison", title: "forged" },
    });
    const { discovery, savedLists } = setup(memory.db);
    const apply = vi.spyOn(savedLists, "applyLineChanges");
    await expect(
      discovery.claimAnonymousIntent(
        {
          anonymousOwnerId: "anon_device",
          intentId: "sli_poison",
          accountId: ownerAccountId,
          destination: { kind: "existing", listId: "svl_poison" as never },
          trackedQuantity: 1,
          sourceSurface: "search",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "list-unavailable" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("expires stale intents before lookup and enforces the anonymous active-intent cap", async () => {
    const memory = createIntentDb();
    const { discovery } = setup(memory.db);
    memory.insertIntent({ intentId: "sli_expired", expiresAt: "2026-07-12T12:00:00.000Z" });
    await expect(
      discovery.prepareAnonymousClaim({
        anonymousOwnerId: "anon_device",
        intentId: "sli_expired",
        accountId: ownerAccountId,
      }),
    ).rejects.toMatchObject({ code: "intent-expired" });

    for (let index = 0; index < 20; index += 1) {
      memory.insertIntent({ intentId: `sli_${index}`, productId: `cat_${index}::` });
    }
    await expect(
      discovery.createAnonymousIntent({
        anonymousOwnerId: "anon_device",
        sourcePath: "/items/new",
        sourceSurface: "item-detail",
        product: product("new"),
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<SavedListDiscoveryError>>({ code: "intent-limit-reached" }));
  });
});

function emptyDb(): PgQueryable {
  return { query: vi.fn(async () => ({ rows: [] })) } as unknown as PgQueryable;
}

function normalizeTestOptions(value: unknown) {
  return [...(value as { dimensionId: string; optionId: string }[])].sort((left, right) =>
    left.dimensionId < right.dimensionId ? -1 : left.dimensionId > right.dimensionId ? 1 : 0,
  );
}

type IntentRecord = Record<string, unknown> & {
  intent_id: string;
  anonymous_owner_id: string;
  status: "active" | "claiming" | "claimed" | "expired";
  expires_at: string;
};

function createIntentDb() {
  const intents = new Map<string, IntentRecord>();
  const insertIntent = (input: { intentId: string; expiresAt?: string; productId?: string }) => {
    intents.set(input.intentId, {
      intent_id: input.intentId,
      anonymous_owner_id: "anon_device",
      anonymous_owner_fingerprint: null,
      owner_revision: 0,
      source_path: "/search",
      source_surface: "search",
      catalog_catalog_item_id: "cat_card",
      product_id: input.productId ?? "cat_card::condition:near-mint",
      selected_options: [{ dimensionId: "condition", optionId: "near-mint" }],
      product_summary: null,
      add_command_id: `slc_${input.intentId}`,
      line_id: `sll_${input.intentId}`,
      status: "active",
      claimed_account_id: null,
      claimed_list_id: null,
      claimed_create_command_id: null,
      claimed_list_title: null,
      claimed_tracked_quantity: null,
      claimed_expected_version: null,
      claimed_response: null,
      claimed_at: null,
      expires_at: input.expiresAt ?? "2026-08-12T12:00:00.000Z",
      created_at: now,
      updated_at: now,
    });
  };
  const query = vi.fn(async (sqlValue: string, values: readonly unknown[] = []) => {
    const sql = sqlValue.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT intent_id, owner_revision")) {
      return {
        rows: [...intents.values()].filter(
          (intent) => intent.anonymous_owner_id === values[0] && intent.anonymous_owner_fingerprint === null,
        ),
      };
    }
    if (sql.startsWith("UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_fingerprint")) {
      const intent = intents.get(String(values[0]));
      if (intent && intent.owner_revision === values[1] && intent.anonymous_owner_fingerprint === null) {
        intent.anonymous_owner_fingerprint = values[2];
        intent.owner_revision = Number(intent.owner_revision) + 1;
      }
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE collections_anonymous_saved_list_intents SET status = 'expired'")) {
      for (const intent of intents.values()) {
        if (
          intent.anonymous_owner_fingerprint === values[0] &&
          intent.status === "active" &&
          new Date(intent.expires_at).getTime() <= new Date(now).getTime()
        )
          intent.status = "expired";
      }
      return { rows: [] };
    }
    if (sql.startsWith("SELECT intent_id, anonymous_owner_fingerprint") && sql.includes("WHERE intent_id")) {
      const intent = intents.get(String(values[0]));
      return { rows: intent && intent.anonymous_owner_fingerprint === values[1] ? [intent] : [] };
    }
    if (
      sql.startsWith("SELECT intent_id, anonymous_owner_fingerprint") &&
      sql.includes("WHERE anonymous_owner_fingerprint")
    ) {
      const match = [...intents.values()].find(
        (intent) =>
          intent.anonymous_owner_fingerprint === values[0] &&
          intent.status === "active" &&
          intent.product_id === values[2] &&
          (sql.includes("selected_options @>")
            ? JSON.stringify(normalizeTestOptions(intent.selected_options)) ===
              JSON.stringify(normalizeTestOptions(JSON.parse(String(values[3]))))
            : JSON.stringify(intent.selected_options) === values[3]),
      );
      return { rows: match ? [match] : [] };
    }
    if (sql.startsWith("SELECT count(*)::text AS count")) {
      const count = [...intents.values()].filter(
        (intent) => intent.anonymous_owner_fingerprint === values[0] && intent.status === "active",
      ).length;
      return { rows: [{ count: String(count) }] };
    }
    if (sql.startsWith("UPDATE collections_anonymous_saved_list_intents SET source_path")) {
      const intent = intents.get(String(values[0]));
      if (!intent || intent.status !== "active" || intent.owner_revision !== values[5]) return { rows: [] };
      Object.assign(intent, {
        source_path: values[1],
        source_surface: values[2],
        product_summary: values[3],
        expires_at: values[4],
        owner_revision: Number(intent.owner_revision) + 1,
      });
      return { rows: [intent] };
    }
    if (sql.startsWith("INSERT INTO collections_anonymous_saved_list_intents")) {
      const record: IntentRecord = {
        intent_id: String(values[0]),
        anonymous_owner_id: String(values[11]),
        anonymous_owner_fingerprint: String(values[1]),
        owner_revision: 0,
        source_path: values[2],
        source_surface: values[3],
        catalog_catalog_item_id: values[4],
        product_id: values[5],
        selected_options: JSON.parse(String(values[6])),
        product_summary: values[7],
        add_command_id: values[8],
        line_id: values[9],
        status: "active",
        claimed_account_id: null,
        claimed_list_id: null,
        claimed_create_command_id: null,
        claimed_list_title: null,
        claimed_tracked_quantity: null,
        claimed_expected_version: null,
        claimed_response: null,
        claimed_at: null,
        expires_at: String(values[10]),
        created_at: now,
        updated_at: now,
      };
      intents.set(record.intent_id, record);
      return { rows: [record] };
    }
    if (sql.includes("SET status = 'claiming'")) {
      const intent = intents.get(String(values[0]));
      if (!intent || intent.status !== "active" || intent.owner_revision !== values[7]) return { rows: [] };
      Object.assign(intent, {
        status: "claiming",
        claimed_account_id: values[2],
        claimed_list_id: values[3],
        claimed_create_command_id: values[4],
        claimed_list_title: values[5],
        claimed_tracked_quantity: values[6],
        owner_revision: Number(intent.owner_revision) + 1,
      });
      return { rows: [intent] };
    }
    if (sql.includes("SET claimed_expected_version")) {
      const intent = intents.get(String(values[0]));
      if (!intent || intent.owner_revision !== values[5]) return { rows: [] };
      intent.claimed_expected_version = values[4];
      intent.owner_revision = Number(intent.owner_revision) + 1;
      return { rows: [{ owner_revision: intent.owner_revision }] };
    }
    if (sql.includes("SET status = 'claimed'")) {
      const intent = intents.get(String(values[0]));
      if (intent && intent.owner_revision === values[5]) {
        intent.status = "claimed";
        intent.claimed_response = JSON.parse(String(values[4]));
        intent.claimed_at = intent.claimed_at ?? now;
        intent.owner_revision = Number(intent.owner_revision) + 1;
        return { rows: [{ owner_revision: intent.owner_revision }] };
      }
      return { rows: [] };
    }
    if (sql.startsWith("SELECT list_id, title")) return { rows: [] };
    throw new Error(`Unexpected test SQL: ${sql}`);
  });
  return { intents, insertIntent, db: { query } as unknown as PgQueryable };
}
