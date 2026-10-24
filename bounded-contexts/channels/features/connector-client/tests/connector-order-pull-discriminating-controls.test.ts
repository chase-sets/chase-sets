import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as canonical from "../../listing-composition/domain/canonical-json";
import * as codec from "../../outbound-sync/domain/order-pull-codec";
import * as progressCodec from "../../outbound-sync/domain/order-pull-progress-codec";
import * as sale from "../../tcgplayer-orders/domain/contracts";
import * as fulfillment from "../../order-fulfillment-observations/domain/contracts";
import * as protocol from "../domain/operation-protocol";
import * as records from "../domain/extension-records";
import * as handoffModule from "../domain/order-pull-handoff";
import { createOrderPullExecution } from "../domain/order-pull-execution";
import { syntheticPage } from "../../outbound-sync/tests/order-pull-fixtures";
import { evaluate } from "./coordinator-mutation-support";
import { pullFixture } from "./connector-order-pull-test-support";

function mutatedHandoff(before: string, after: string) {
  const source = readFileSync(new URL("../domain/order-pull-handoff.ts", import.meta.url), "utf8");
  expect(source.split(before)).toHaveLength(2);
  return evaluate(source.replace(before, after), {
    "../../listing-composition/domain/canonical-json": canonical,
    "../../outbound-sync/domain/order-pull-codec": codec,
    "../../outbound-sync/domain/order-pull-progress-codec": progressCodec,
    "../../tcgplayer-orders/domain/contracts": sale,
    "../../order-fulfillment-observations/domain/contracts": fulfillment,
    "./operation-codec": protocol,
    "./extension-records": records,
  }) as typeof handoffModule;
}

describe("connector-order-pull discriminating controls", () => {
  it("kills the single-page fallback with the same full-page continuation witness", async () => {
    const f = await pullFixture();
    const handoff = {
      ...f.handoff,
      bundles: [],
      summary: { ...f.handoff.summary!, state: "captured202" as const },
      progress: {
        ...f.handoff.progress,
        pages: [
          syntheticPage(
            Array.from({ length: 100 }, (_, i) => `SYNTHETIC-${i}`),
            { nextCursor: "next", totalOrders: 100 },
          ),
        ],
      },
    };
    const mutant = mutatedHandoff(
      "const kind = orderPullProgressKind({",
      "if (traversal && !traversal.exhausted) refuse();\nconst kind = orderPullProgressKind({",
    );
    expect(handoffModule.orderPullHandoffOutcome(f.payload, handoff).kind).toBe("continuation-required");
    expect(() => mutant.orderPullHandoffOutcome(f.payload, handoff)).toThrow();
  });
  it("kills 202-is-accepted without changing the posted-only witness", async () => {
    const f = await pullFixture();
    await f.coordinator().coordinate(f.input);
    const member = (await f.journal.read(f.input.connectionId)).members[0];
    if (member.operationKind !== "tcgplayer-order-pull") throw new Error("fixture drift");
    const mutant = mutatedHandoff(
      "new Set(payload.work.acceptedReferences)",
      "new Set([...payload.work.acceptedReferences, ...handoff.progress.postedReferences])",
    );
    expect(handoffModule.orderPullHandoffOutcome(f.payload, member.handoff!).kind).toBe("order-pull-pending");
    expect(mutant.orderPullHandoffOutcome(f.payload, member.handoff!).kind).toBe("order-pull-complete");
  });
  it("kills drop-tail without changing the unread member witness", async () => {
    const f = await pullFixture();
    const handoff = { ...f.handoff, bundles: [], summary: { ...f.handoff.summary!, state: "captured202" as const } };
    const mutant = mutatedHandoff(
      "references.some((ref) => !accepted.has(ref) && !posted.has(ref) && !gaps.has(ref))",
      "false",
    );
    expect(handoffModule.orderPullHandoffOutcome(f.payload, handoff).kind).toBe("continuation-required");
    expect(mutant.orderPullHandoffOutcome(f.payload, handoff).kind).toBe("order-pull-complete");
  });
  it("kills report-early at the admission boundary", async () => {
    const f = await pullFixture();
    const source = readFileSync(new URL("../domain/order-pull-handoff.ts", import.meta.url), "utf8");
    const start = source.lastIndexOf("  if", source.indexOf('handoff.summary.state !== "captured202"'));
    const end = source.indexOf("  let traversal", start);
    expect(start).toBeGreaterThan(0);
    const mutant = mutatedHandoff(source.slice(start, end), "");
    expect(() => handoffModule.orderPullHandoffOutcome(f.payload, f.handoff)).toThrow();
    expect(mutant.orderPullHandoffOutcome(f.payload, f.handoff).kind).toBe("continuation-required");
  });
  it("kills PII-field bypass with a closed-sale sentinel", async () => {
    const f = await pullFixture();
    const post = f.handoff.bundles[0].posts![0];
    if (post.kind !== "sale") throw new Error("fixture drift");
    const body = JSON.parse(post.bytes);
    body.payload.records[0].shipTo = "SYNTHETIC_PII_SENTINEL";
    const handoff = {
      ...f.handoff,
      bundles: [{ ...f.handoff.bundles[0], posts: [{ ...post, bytes: JSON.stringify(body) }] }],
    };
    const mutant = mutatedHandoff("assertTcgplayerOrderRecord(payload.records[0]);", "");
    expect(() => handoffModule.parseOrderPullHandoff(handoff, f.payload)).toThrow();
    expect(JSON.stringify(mutant.parseOrderPullHandoff(handoff, f.payload))).toContain("SYNTHETIC_PII_SENTINEL");
  });
  it.each([false, true])("deadline bypass=%s changes the zero-post witness", async (bypass) => {
    const f = await pullFixture();
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      await pull!.save(f.handoff);
      throw new Error("synthetic stop");
    });
    await f.coordinator().coordinate(f.input);
    let member = (await f.journal.read(f.input.connectionId)).members[0];
    if (member.operationKind !== "tcgplayer-order-pull") throw new Error("fixture drift");
    const before = "now + budgetMs > Date.parse(member.dispatchedAt) + member.payload.bounds.budgetMs";
    const source = readFileSync(new URL("../domain/order-pull-execution.ts", import.meta.url), "utf8");
    expect(source.split(before)).toHaveLength(2);
    const mutant = evaluate(source.replace(before, "false"), {
      "../../listing-composition/domain/canonical-json": canonical,
      "../../outbound-sync/domain/order-pull-codec": codec,
      "./order-pull-handoff": handoffModule,
      "./operation-protocol": protocol,
    }) as { createOrderPullExecution: typeof createOrderPullExecution };
    const pull = (bypass ? mutant.createOrderPullExecution : createOrderPullExecution)({
      current: () => {
        if (member.operationKind !== "tcgplayer-order-pull") throw new Error("fixture drift");
        return member;
      },
      save: async (handoff) => {
        member = { ...member, handoff } as typeof member;
      },
      fence: async () => true,
      now: () => f.now() + f.payload.bounds.budgetMs + 1,
      signal: new AbortController().signal,
    });
    if (bypass) await pull.sale("SYNTHETIC-ORDER-1", 0, f.post);
    else await expect(pull.sale("SYNTHETIC-ORDER-1", 0, f.post)).rejects.toThrow("stale-fence");
    expect(f.posts.length).toBe(bypass ? 1 : 0);
  });
});
