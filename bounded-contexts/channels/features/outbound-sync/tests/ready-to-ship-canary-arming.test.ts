import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { armReadyToShipCanary } from "../api/ready-to-ship-canary";
import { assertCanaryHandoff, canarySalePullId } from "../domain/ready-to-ship-canary";

it("rejects changed sale bytes before insertion and treats the intact digest as one arming", async () => {
  const pageClaim = "00000000-0000-4000-8000-000000000055";
  const target = { connectionId: "synthetic-connection", pairingId: "synthetic-pairing" };
  const fence = { ...target, grantId: "synthetic-grant" };
  const finishedAt = "2030-01-01T00:00:00.000Z";
  const expiresAt = "2030-01-01T00:05:00.000Z";
  const orders = [
    {
      orderNumber: "SYNTHETIC-ORDER",
      soldAt: finishedAt,
      lines: [{ productId: "1", skuId: "2", quantity: 1, unitPriceAmount: "1.00" }],
    },
  ];
  const sealDigest = createHash("sha256")
    .update(
      JSON.stringify([
        "ready-to-ship-sale-handoff/v1",
        pageClaim,
        target.connectionId,
        target.pairingId,
        finishedAt,
        expiresAt,
      ]),
    )
    .update("\n")
    .update(JSON.stringify(orders))
    .digest("hex");
  const sale = {
    version: 1,
    kind: "order",
    pullId: canarySalePullId(pageClaim),
    cancelled: false,
    ...orders[0]!,
  } as const;
  const exact = { pageClaim, sealDigest, target, finishedAt, expiresAt, sales: [sale] };
  const arm = (value: unknown) => {
    assertCanaryHandoff(value);
    return armReadyToShipCanary(db, fence, value, finishedAt);
  };
  const inserted: unknown[] = [];
  const query = vi.fn().mockImplementation(async (sql: string, params: readonly unknown[]) => {
    if (sql.includes("INSERT") && !inserted.length) {
      inserted.push(JSON.parse(String(params[6])));
      return { rows: [{ page_claim: pageClaim }] };
    }
    if (sql.includes("SELECT") && inserted.length) return { rows: [{ page_claim: pageClaim }] };
    return { rows: [] };
  });
  const db = { query } satisfies PgQueryable;
  const changed = { ...exact, sales: [{ ...sale, lines: [{ ...sale.lines[0]!, quantity: 2 }] }] };
  await expect(arm(changed)).rejects.toMatchObject({ code: "invalid-request" });
  await expect(arm({ ...exact, expiresAt: "2030-01-01T00:04:59.999Z" })).rejects.toMatchObject({
    code: "invalid-request",
  });
  expect(query).not.toHaveBeenCalled();
  await expect(arm(exact)).resolves.toBeUndefined();
  await expect(arm(exact)).resolves.toBeUndefined();
  expect(inserted).toEqual([exact]);
});
