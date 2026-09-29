import { expect, it } from "vitest";
import { fixture } from "../../repricing-engine/tests/listing-authority-fixture";
import { invalidatePricingEstimate } from "./listing-authority-validity";

it("invalidates the exact published estimate before expiration and replays without another mutation", async () => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  await f.source.prepare(operation, f.context);
  const input = {
    catalogItemId: f.request.catalogItemId,
    productId: f.request.productId,
    observedUpdatedAt: f.evaluation.capturedAt,
    expiredAt: new Date(Date.parse(f.evaluation.capturedAt) - 1).toISOString(),
  };
  expect(
    await invalidatePricingEstimate(
      f.authority.eventStore,
      { ...input, observedUpdatedAt: "2000-01-01T00:00:00.000Z" },
      f.context,
    ),
  ).toBe(false);
  expect((await f.fence.inspect(operation)).status).toBe("pending");
  expect(await invalidatePricingEstimate(f.authority.eventStore, input, f.context)).toBe(true);
  expect((await f.fence.inspect(operation)).status).toBe("aborted");
  const before = structuredClone([...f.sourceMemory.streams]);
  expect(await invalidatePricingEstimate(f.authority.eventStore, input, f.context)).toBe(true);
  expect([...f.sourceMemory.streams]).toEqual(before);
  await expect(f.authority.evaluate({ ...f.request, evaluationId: "synthetic-expired" }, f.context)).rejects.toThrow(
    "does not authorize",
  );
});
