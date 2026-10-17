import { afterEach, expect, it } from "vitest";
import { startLoopback } from "../__tests__/harness/loopback";
import { syntheticClaim } from "../__tests__/harness/claim";
import { platformOrigin } from "../__tests__/harness/origins";
import { synthetic } from "../e2e/loopback-platform";

let server: Awaited<ReturnType<typeof startLoopback>> | undefined;
afterEach(async () => {
  await server?.close();
});
it("connector-fake-public-codecs calls both public validators on the actual HTTP fake", async () => {
  server = await startLoopback();
  const claim = syntheticClaim();
  server.claims.push(claim);
  const send = (action: string, value: unknown) =>
    fetch(`${platformOrigin}/channel-connector/oauth/connections/connection_synthetic/${action}`, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${synthetic.access}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  expect((await send("claim", { injected: true })).status).toBe(400);
  expect((await send("claim", {})).status).toBe(200);
  const report = {
    reservationId: claim.reservationId,
    outcomes: [
      {
        operationId: "synthetic-operation",
        attemptId: "synthetic-attempt",
        claimGeneration: 1,
        desiredStateSequence: 1,
        outcome: { kind: "outcome-unknown" },
      },
    ],
  };
  expect((await send("report", { ...report, injected: true })).status).toBe(400);
  expect((await send("report", report)).status).toBe(200);
  expect((await send("report", report)).status).toBe(200);
  expect(server.reports).toHaveLength(2);
  for (const invalid of [
    { ...report, outcomes: [] },
    { ...report, outcomes: report.outcomes.map((outcome) => ({ ...outcome, claimGeneration: 2 })) },
    {
      ...report,
      outcomes: report.outcomes.map((outcome) => ({
        ...outcome,
        outcome: { kind: "abandoned", reason: "claimant-cancelled" },
      })),
    },
  ])
    expect((await send("report", invalid)).status).toBe(400);
});
