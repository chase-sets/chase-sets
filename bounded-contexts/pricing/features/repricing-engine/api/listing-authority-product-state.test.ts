import { expect, it } from "vitest";
import { fixture } from "../tests/listing-authority-fixture";
import { sqlFixture } from "../tests/listing-authority-sql-fixture";
import { createPricingProductRoundAuthority } from "./listing-authority-product-state";
import { repricingEnginePolicy } from "../domain/policy";

it("guards the actual cooldown/direction writers, retaining trigger and round identities across commit loss", async () => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  await f.source.prepare(operation, f.context);
  const at = "2026-09-28T00:00:00.000Z";
  const sql = sqlFixture(
    {
      effects: 0,
      state: {
        next_eligible_at: at,
        same_direction_rounds: 0,
        last_direction: null as string | null,
        frozen_until: null as string | null,
        updated_at: at,
      },
    },
    (data, query, values) => {
      if (query.includes("INSERT INTO pricing_repricing_product_round_cooldowns")) return { rows: [] };
      if (query.startsWith("SELECT next_eligible_at")) return { rows: [data.state] };
      if (query.includes("SET next_eligible_at = $3")) {
        data.effects++;
        data.state.next_eligible_at = new Date(
          Date.parse(String(values[2])) + Number(values[3]) * 60_000,
        ).toISOString();
        return { rows: [], rowCount: 1 };
      }
      if (query.includes("SET same_direction_rounds")) {
        data.effects++;
        data.state.same_direction_rounds = Number(values[2]);
        data.state.last_direction = values[3] as string | null;
        data.state.frozen_until = values[4] as string | null;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected Product SQL: ${query}`);
    },
  );
  const owner = () => createPricingProductRoundAuthority(sql.pool, f.restart().source);
  const product = { catalogItemId: f.request.catalogItemId, productId: f.request.productId };
  const reserve = { ...product, triggerEventId: "evt_synthetic_trigger", cooldownMinutes: 5 };
  sql.loseNextCommit();
  await expect(owner().reserve(reserve, at, f.context)).rejects.toThrow("unresolved");
  expect((await f.fence.inspect(operation)).status).toBe("aborted");
  expect(await owner().reserve(reserve, "2026-09-28T00:01:00.000Z", f.context)).toBe(true);
  expect(sql.data.effects).toBe(1);
  expect(sql.data.state.next_eligible_at).toBe("2026-09-28T00:05:00.000Z");
  const policy = { ...repricingEnginePolicy.defaultValue, spiralBreakerRounds: 1 };
  sql.loseNextCommit();
  await expect(owner().record(product, "down", policy, at, "synthetic-round", f.context)).rejects.toThrow("unresolved");
  const result = await owner().record(
    product,
    "down",
    policy,
    "2026-09-28T00:01:00.000Z",
    "synthetic-round",
    f.context,
  );
  expect(result).toMatchObject({ direction: "down", roundCount: 1 });
  expect(sql.data.effects).toBe(2);
  expect(sql.receipts.size).toBe(2);
  await expect(owner().record(product, "up", policy, at, "synthetic-round", f.context)).rejects.toThrow(
    "identity conflict",
  );
  await expect(owner().reserve({ ...reserve, cooldownMinutes: 10 }, at, f.context)).rejects.toThrow(
    "identity conflict",
  );
});
