import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createProductAlertRuntime } from "./runtime";

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

type AnonymousProductAlertIntentRow = {
  intent_id: string;
  anonymous_owner_id: string;
  source_path: string;
  market_side: "listing" | "offer";
  catalog_catalog_item_id: string;
  product_id: string;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  threshold_amount: string | null;
  status: "active" | "claimed" | "expired";
  claimed_account_id: string | null;
  claimed_alert_id: string | null;
  claimed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

function createAnonymousProductAlertIntentDb() {
  const rows: AnonymousProductAlertIntentRow[] = [];
  const now = () => new Date().toISOString();
  const selectedOptionsMatch = (row: AnonymousProductAlertIntentRow, value: unknown) =>
    JSON.stringify(row.selected_options) === String(value);
  const thresholdAmountMatch = (row: AnonymousProductAlertIntentRow, value: unknown) =>
    row.threshold_amount === (value === null ? null : String(value));
  const isActive = (row: AnonymousProductAlertIntentRow) =>
    row.status === "active" && new Date(row.expires_at).getTime() > Date.now();

  const db = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("SET status = 'expired'")) {
        const ownerId = String(params[0] ?? "");
        for (const row of rows) {
          if (row.anonymous_owner_id === ownerId && row.status === "active" && !isActive(row)) {
            row.status = "expired";
            row.updated_at = now();
          }
        }
        return { rows: [] };
      }

      if (sql.includes("ORDER BY updated_at DESC")) {
        return {
          rows: rows
            .filter(
              (row) =>
                row.anonymous_owner_id === params[0] &&
                isActive(row) &&
                row.market_side === params[1] &&
                row.catalog_catalog_item_id === params[2] &&
                row.product_id === params[3] &&
                selectedOptionsMatch(row, params[4]) &&
                thresholdAmountMatch(row, params[5]),
            )
            .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
            .slice(0, 1),
        };
      }

      if (sql.includes("SELECT count(*)::text AS count")) {
        return {
          rows: [
            {
              count: String(rows.filter((row) => row.anonymous_owner_id === params[0] && isActive(row)).length),
            },
          ],
        };
      }

      if (sql.includes("INSERT INTO discovery_anonymous_product_alert_intents")) {
        const row: AnonymousProductAlertIntentRow = {
          intent_id: String(params[0]),
          anonymous_owner_id: String(params[1]),
          source_path: String(params[2]),
          market_side: params[3] === "offer" ? "offer" : "listing",
          catalog_catalog_item_id: String(params[4]),
          product_id: String(params[5]),
          selected_options: JSON.parse(String(params[6])) as AnonymousProductAlertIntentRow["selected_options"],
          product_summary: params[7] === null ? null : String(params[7]),
          threshold_amount: params[8] === null ? null : String(params[8]),
          expires_at: String(params[9]),
          status: "active",
          claimed_account_id: null,
          claimed_alert_id: null,
          claimed_at: null,
          created_at: now(),
          updated_at: now(),
        };
        rows.push(row);
        return { rows: [row] };
      }

      if (sql.includes("SET source_path = $2")) {
        const row = rows.find((candidate) => candidate.intent_id === params[0]);
        if (!row) {
          return { rows: [] };
        }
        row.source_path = String(params[1]);
        row.product_summary = params[2] === null ? null : String(params[2]);
        row.expires_at = String(params[3]);
        row.updated_at = now();
        return { rows: [row] };
      }

      if (sql.includes("SET status = 'claimed'")) {
        const row = rows.find(
          (candidate) => candidate.intent_id === params[0] && candidate.anonymous_owner_id === params[1],
        );
        if (!row || !isActive(row)) {
          return { rows: [] };
        }
        row.status = "claimed";
        row.claimed_account_id = String(params[2]);
        row.claimed_alert_id = String(params[3]);
        row.claimed_at = now();
        row.updated_at = now();
        return { rows: [row] };
      }

      if (sql.includes("SET status = 'active'") && sql.includes("claimed_alert_id = NULL")) {
        const row = rows.find(
          (candidate) =>
            candidate.intent_id === params[0] &&
            candidate.anonymous_owner_id === params[1] &&
            candidate.status === "claimed" &&
            candidate.claimed_account_id === params[2] &&
            candidate.claimed_alert_id === params[3],
        );
        if (!row) {
          return { rows: [] };
        }
        row.status = "active";
        row.claimed_account_id = null;
        row.claimed_alert_id = null;
        row.claimed_at = null;
        row.updated_at = now();
        return { rows: [row] };
      }

      if (sql.includes("WHERE intent_id = $1") && sql.includes("anonymous_owner_id = $2")) {
        return {
          rows: rows.filter((row) => row.intent_id === params[0] && row.anonymous_owner_id === params[1]).slice(0, 1),
        };
      }

      throw new Error(`Unexpected query in test: ${sql}`);
    }),
  };

  return { db, rows };
}

const context = {
  tenantId: "tnt_discovery" as never,
  audit: {
    performedByUserId: "usr_buyer" as never,
    forAccountId: "acc_buyer" as never,
  },
};

describe("product alert runtime anonymous intents", () => {
  it("deduplicates, claims once, and creates no Product Alert event before claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    const { eventStore } = createInMemoryEventStore();
    const { db, rows } = createAnonymousProductAlertIntentDb();
    const services = createProductAlertRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    try {
      const first = await services.createAnonymousProductAlertIntent({
        anonymousOwnerId: "anon_watch_1",
        sourcePath: "/items/charizard-base-set?market=watch",
        marketSide: "listing",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        selectedOptions: [
          { dimensionId: "grade", optionId: "ungraded" },
          { dimensionId: "form", optionId: "raw" },
        ],
        productSummary: "Raw",
        thresholdAmount: "20",
      });

      vi.setSystemTime(new Date("2026-06-10T13:00:00.000Z"));
      const second = await services.createAnonymousProductAlertIntent({
        anonymousOwnerId: "anon_watch_1",
        sourcePath: "/items/charizard?market=watch",
        marketSide: "listing",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        selectedOptions: [
          { dimensionId: "form", optionId: "raw" },
          { dimensionId: "grade", optionId: "ungraded" },
        ],
        productSummary: "Raw updated",
        thresholdAmount: "20.00",
      });

      expect(second.intent_id).toBe(first.intent_id);
      expect(second).toMatchObject({
        source_path: "/items/charizard?market=watch",
        selected_options: [
          { dimensionId: "form", optionId: "raw" },
          { dimensionId: "grade", optionId: "ungraded" },
        ],
        product_summary: "Raw updated",
        threshold_amount: "20.00",
        status: "active",
        expires_at: "2026-07-10T13:00:00.000Z",
      });
      expect(rows).toHaveLength(1);
      expect(await eventStore.readAll()).toEqual([]);

      const claimed = await services.claimAnonymousProductAlertIntent(
        {
          anonymousOwnerId: "anon_watch_1",
          intentId: first.intent_id,
          accountId: "acc_buyer",
        },
        context,
      );

      expect(claimed).toMatchObject({
        intent_id: first.intent_id,
        status: "claimed",
        claimed_account_id: "acc_buyer",
        threshold_amount: "20.00",
      });
      expect(claimed.claimed_alert_id).toMatch(/^pal_/);
      expect(await eventStore.readAll()).toHaveLength(1);
      await expect(
        services.claimAnonymousProductAlertIntent(
          {
            anonymousOwnerId: "anon_watch_1",
            intentId: first.intent_id,
            accountId: "acc_buyer",
          },
          context,
        ),
      ).resolves.toMatchObject({ status: "claimed" });
      expect(await eventStore.readAll()).toHaveLength(1);
      await expect(
        services.claimAnonymousProductAlertIntent(
          {
            anonymousOwnerId: "anon_watch_1",
            intentId: first.intent_id,
            accountId: "acc_other",
          },
          context,
        ),
      ).rejects.toThrow("Watch alert is no longer available.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the 20 active anonymous Watch intent cap per owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    const { eventStore } = createInMemoryEventStore();
    const { db } = createAnonymousProductAlertIntentDb();
    const services = createProductAlertRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    try {
      for (let index = 0; index < 20; index += 1) {
        await services.createAnonymousProductAlertIntent({
          anonymousOwnerId: "anon_watch_1",
          sourcePath: `/items/card-${index}?market=watch`,
          marketSide: "listing",
          catalogItemId: `cat_${index}`,
          productId: `cat_${index}::form:raw`,
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Raw",
          thresholdAmount: null,
        });
      }

      await expect(
        services.createAnonymousProductAlertIntent({
          anonymousOwnerId: "anon_watch_1",
          sourcePath: "/items/card-overflow?market=watch",
          marketSide: "listing",
          catalogItemId: "cat_overflow",
          productId: "cat_overflow::form:raw",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Raw",
          thresholdAmount: null,
        }),
      ).rejects.toThrow("Too many saved Watch alerts.");
      expect(await eventStore.readAll()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires stale intents and rejects claim after the 30-day TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    const { eventStore } = createInMemoryEventStore();
    const { db, rows } = createAnonymousProductAlertIntentDb();
    const services = createProductAlertRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    try {
      const intent = await services.createAnonymousProductAlertIntent({
        anonymousOwnerId: "anon_watch_1",
        sourcePath: "/items/charizard-base-set?market=watch",
        marketSide: "offer",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Raw",
        thresholdAmount: "350.00",
      });

      vi.setSystemTime(new Date("2026-07-10T12:00:00.001Z"));
      await expect(
        services.claimAnonymousProductAlertIntent(
          {
            anonymousOwnerId: "anon_watch_1",
            intentId: intent.intent_id,
            accountId: "acc_buyer",
          },
          context,
        ),
      ).rejects.toThrow("Watch alert is no longer available.");
      expect(rows[0]?.status).toBe("expired");
      expect(await eventStore.readAll()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a claimed anonymous intent when account Product Alert creation fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    const { db, rows } = createAnonymousProductAlertIntentDb();
    const eventStore: EventStore = {
      appendToStream: vi.fn(async () => {
        throw new Error("Event store unavailable.");
      }),
      readStream: vi.fn(async () => []),
      readAll: vi.fn(async () => []),
    };
    const services = createProductAlertRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    try {
      const intent = await services.createAnonymousProductAlertIntent({
        anonymousOwnerId: "anon_watch_1",
        sourcePath: "/items/charizard-base-set?market=watch",
        marketSide: "listing",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Raw",
        thresholdAmount: null,
      });

      await expect(
        services.claimAnonymousProductAlertIntent(
          {
            anonymousOwnerId: "anon_watch_1",
            intentId: intent.intent_id,
            accountId: "acc_buyer",
          },
          context,
        ),
      ).rejects.toThrow("Event store unavailable.");
      expect(rows[0]).toMatchObject({
        intent_id: intent.intent_id,
        status: "active",
        claimed_account_id: null,
        claimed_alert_id: null,
        claimed_at: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
