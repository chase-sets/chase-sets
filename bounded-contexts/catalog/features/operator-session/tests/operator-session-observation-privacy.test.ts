import { afterEach, expect, it, vi } from "vitest";
import { harness, partBody, completionBody, batchId, input, current, streamId } from "./market-observation-fixture";

afterEach(() => vi.restoreAllMocks());
it("rejects credential markers split across two otherwise valid parts", async () => {
  const h = harness();
  h.currentRequest.mockResolvedValue({
    ...current,
    products: [{ productId: 1, skuIds: Array.from({ length: 250 }, (_, i) => i + 1), skuTargetCount: 250 }],
  });
  expect((await h.routes.part(input(partBody("a".repeat(29997) + "bea")), batchId, "0")).status).toBe(200);
  expect((await h.routes.part(input(partBody("rer hostile")), batchId, "1")).status).toBe(400);
  const events = await h.store.readStream({ streamId });
  expect(events).toHaveLength(1);
  expect(events.map((event) => event.payload.text).join("")).not.toContain("bearer hostile");
});
it("keeps hostile Cookie, TCGAuthTicket, bearer and seller-name markers out of responses, logs and events", async () => {
  const h = harness();
  const logs: unknown[] = [];
  for (const key of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, key).mockImplementation((...args) => {
      logs.push(args);
    });
  const markers = [
    "Cookie: hostile-cookie",
    "TCGAuthTicket=hostile-ticket",
    "Bearer hostile-bearer",
    '"sellerName":"hostile-seller-name"',
  ];
  const responses: string[] = [];
  const headers = {
    cookie: markers[1]!,
    "x-forwarded-authorization": markers[2]!,
    "x-seller-name": "hostile-seller-name",
  };
  responses.push(await (await h.routes.part(input(partBody(), "PUT", headers), batchId, "0")).text());
  responses.push(await (await h.routes.complete(input(await completionBody(), "POST", headers), batchId)).text());
  for (const marker of markers) {
    const refused = await h.routes.part(input(partBody(marker), "PUT", headers), batchId, "0");
    expect(refused.status).toBe(400);
    responses.push(await refused.text());
    const unknown = await h.routes.complete(
      input({ ...(await completionBody()), sellerName: marker }, "POST"),
      batchId,
    );
    expect(unknown.status).toBe(400);
    responses.push(await unknown.text());
  }
  h.currentRequest.mockRejectedValue(new Error(markers.join(" ")));
  responses.push(await (await h.routes.current(input(undefined, "GET", headers))).text());
  const evidence = JSON.stringify({ responses, logs, events: h.appendToStream.mock.calls });
  for (const marker of [...markers, "hostile-cookie", "hostile-ticket", "hostile-bearer", "hostile-seller-name"])
    expect(evidence).not.toContain(marker);
});
