import { expect, it } from "vitest";
import { fixture } from "../tests/listing-authority-fixture";
import { sqlFixture } from "../tests/listing-authority-sql-fixture";
import {
  createPricingAuthoritySqlWriter,
  createPricingEvaluationBudget,
  PricingSqlMutationPendingError,
} from "./listing-authority-sql";
import { pricingAuthorityResources } from "./listing-authority-resources";

it("persists closure before remote invalidation; unknown consumer never reaches SQL; restart uses the same receipt", async () => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  await f.source.prepare(operation, f.context);
  const sql = sqlFixture({ effects: 0 }, (data, query) => {
    if (query.includes("FROM event_store_events pending")) {
      const rows = [...f.sourceMemory.streams.values()].flatMap((history) =>
        history
          .filter(
            (event) =>
              event.eventType === "pricing.listing-authority.invalidation-started" &&
              (event.payload.intent as { command?: { kind?: string } } | undefined)?.command?.kind ===
                "synthetic-effect" &&
              !history.some((terminal) => terminal.eventType === "pricing.listing-authority.invalidation-completed"),
          )
          .map((event) => ({
            global_position: String(event.globalPosition),
            tenant_id: event.tenantId,
            payload: event.payload,
          })),
      );
      return { rows };
    }
    expect(query).toBe("synthetic-effect");
    data.effects++;
    return { rows: [] };
  });
  const command = { kind: "synthetic-effect", body: {}, context: { ...f.context, traceId: undefined } };
  const mutationId = "synthetic-sql-unknown";
  const writer = (source = f.source) =>
    createPricingAuthoritySqlWriter({
      pool: sql.pool,
      source,
      handlers: {
        "synthetic-effect": {
          resources: async () => [pricingAuthorityResources.account(f.context.audit.forAccountId)],
          apply: async (db) => {
            expect((await f.fence.inspect(operation)).status).toBe("aborted");
            expect((await source.inspectInvalidation(f.context.tenantId, mutationId))?.status).toBe("pending");
            await db.query("synthetic-effect");
            return { effect: 1 };
          },
        },
      },
    });
  f.blockInvalidation(true);
  await expect(writer().run(mutationId, command)).rejects.toBeInstanceOf(PricingSqlMutationPendingError);
  expect(sql.statements).toEqual([]);
  expect((await f.source.inspectInvalidation(f.context.tenantId, mutationId))?.status).toBe("pending");
  expect((await f.source.inspect(operation))?.status).toBe("reserved");
  f.blockInvalidation(false);
  sql.loseNextCommit();
  const restarted = f.restart();
  await expect(writer(restarted.source).resume(mutationId, command.context)).rejects.toBeInstanceOf(
    PricingSqlMutationPendingError,
  );
  expect(sql.data.effects).toBe(1);
  expect(sql.receipts.size).toBe(1);
  expect((await restarted.source.inspectInvalidation(f.context.tenantId, mutationId))?.status).toBe("pending");
  const recovered = writer(f.restart().source);
  expect((await recovered.recover({ limit: 1 })).outcomes).toEqual([{ mutationId, status: "resumed", error: null }]);
  expect(await recovered.resume(mutationId, command.context)).toEqual({ effect: 1 });
  expect(await recovered.run(mutationId, command)).toEqual({ effect: 1 });
  expect(sql.data.effects).toBe(1);
  await expect(recovered.run(mutationId, { ...command, body: { changed: true } })).rejects.toThrow("identity conflict");
  sql.receipts.clear();
  await expect(recovered.resume(mutationId, command.context)).rejects.toThrow("unresolved");
  expect(sql.data.effects).toBe(1);
});

it("retains closure after an uncommitted SQL failure and replays the original command only", async () => {
  const f = await fixture();
  const sql = sqlFixture({ effects: 0 }, (data) => {
    data.effects++;
    throw new Error("Synthetic SQL rollback");
  });
  let fail = true;
  const writer = createPricingAuthoritySqlWriter({
    pool: sql.pool,
    source: f.source,
    handlers: {
      synthetic: {
        resources: async () => [pricingAuthorityResources.account(f.context.audit.forAccountId)],
        apply: async (db) => {
          if (fail) await db.query("fail");
          return "recovered";
        },
      },
    },
  });
  await expect(writer.run("synthetic-rollback", { kind: "synthetic", body: {}, context: f.context })).rejects.toThrow();
  expect(sql.data.effects).toBe(0);
  expect((await f.source.inspectInvalidation(f.context.tenantId, "synthetic-rollback"))?.status).toBe("pending");
  fail = false;
  expect(await writer.resume("synthetic-rollback", f.context)).toBe("recovered");
  await expect(writer.recover({ limit: 101 })).rejects.toThrow("recovery page");
});

it("uses the existing daily counter once across lost budget commits and idempotent release", async () => {
  const sql = sqlFixture(
    { count: 0, admissions: new Map<string, { binding: string; status: string; accountId: string; day: string }>() },
    (data, query, values) => {
      const id = String(values[0]);
      if (query.startsWith("SELECT binding") || query.startsWith("SELECT seller_account_id AS")) {
        const row = data.admissions.get(id);
        return { rows: row ? [row] : [] };
      }
      if (query.includes("INSERT INTO pricing_repricing_daily_change_budgets")) return { rows: [] };
      if (query.includes("changes_reserved = changes_reserved + 1")) {
        if (data.count >= Number(values[2])) return { rows: [] };
        data.count++;
        return { rows: [{ seller_account_id: id }] };
      }
      if (query.includes("INSERT INTO pricing_evaluation_budget_admissions")) {
        data.admissions.set(id, {
          accountId: String(values[1]),
          day: String(values[2]),
          binding: String(values[3]),
          status: "reserved",
        });
        return { rows: [] };
      }
      if (query.includes("SET status = 'released'")) {
        const row = data.admissions.get(id);
        if (!row || row.status !== "reserved") return { rows: [] };
        row.status = "released";
        return { rows: [{ seller_account_id: row.accountId, budget_day: row.day }] };
      }
      if (query.includes("changes_reserved = changes_reserved - 1")) {
        data.count--;
        return { rows: [] };
      }
      throw new Error(`Unexpected budget SQL: ${query}`);
    },
  );
  const budget = () => createPricingEvaluationBudget(sql.pool);
  const input = { evaluationId: "synthetic-budget", accountId: "acc_synthetic_budget", day: "2026-09-28", limit: 1 };
  sql.loseNextCommit();
  await expect(budget().reserve(input)).rejects.toThrow("lost commit reply");
  expect(sql.data.count).toBe(1);
  expect(await budget().reserve(input)).toBe(true);
  expect(sql.data.count).toBe(1);
  expect(await budget().reserve({ ...input, evaluationId: "synthetic-other" })).toBe(false);
  await expect(budget().reserve({ ...input, day: "2026-09-29" })).rejects.toThrow("identity conflict");
  expect(await budget().inspect(input.evaluationId)).toMatchObject({ status: "reserved", day: input.day });
  await budget().release(input.evaluationId);
  await budget().release(input.evaluationId);
  expect(sql.data.count).toBe(0);
  expect(await budget().reserve(input)).toBe(false);
});
