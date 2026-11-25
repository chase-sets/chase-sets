import { afterEach, expect, it, vi } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createOperatorSessionGrants } from "../api/grants";
import { operatorSessionPublicRoutes } from "../api/route";
import { grantBearer, provenance } from "./set-name-observation-fixture";
import { sealedPartHeaders, sealedPost, sealedRoutePath } from "./sealed-product-observation-fixture";
import { operatorOrigins } from "../domain/extension/protocol";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";

afterEach(() => vi.restoreAllMocks());
it("keeps hostile headers and raw exceptions out of recorder inputs, responses and logs", async () => {
  const queries: unknown[] = [];
  const received: unknown[] = [];
  const logs: unknown[] = [];
  for (const key of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, key).mockImplementation((...args) => {
      logs.push(args);
    });
  const marker = "TCGAuthTicket=hostile-cookie-value";
  const client: PgPoolClient = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT id, creator_user_id"))
        return {
          rows: [
            {
              id: provenance.grantId,
              creator_user_id: provenance.creatorUserId,
              creator_membership_id: provenance.creatorMembershipId,
            } as Row,
          ],
        };
      if (sql.includes("SET last_used_at")) return { rows: [{ id: provenance.grantId } as Row] };
      if (sql.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ locked: true } as Row] };
      if (sql.startsWith("SELECT pg_advisory_unlock")) return { rows: [{ unlocked: true } as Row] };
      return { rows: [] };
    },
    release() {},
  };
  const pool: PgTransactionalPool = { query: client.query, connect: async () => client };
  let fail = false;
  const services = createOperatorSessionGrants(
    pool,
    {
      forActor: vi.fn(),
      forGrantCreator: async () => ({
        kind: "granted",
        membershipId: provenance.creatorMembershipId,
        roleKey: "platform-admin",
        rolePermissions: ["catalog.manage"],
      }),
    },
    {
      tcgplayerSealedProducts: async (input) => {
        received.push(input);
        if (fail) throw new Error(`${marker} Bearer hostile-forwarded-token`);
        return { recorded: 1, changed: 0, unchanged: 0, candidateCount: 0, exclusions: [] };
      },
      answerTcgplayerSealedRequest: async ({ answer, record }) => {
        if (answer.kind !== "part") throw new Error("Expected synthetic part");
        await record(client, answer.post, { unit_key: "synthetic" } as ProviderScopeMappingRow);
        return { kind: "part", partIndex: answer.partIndex };
      },
    },
  );
  const app = operatorSessionPublicRoutes(services);
  const post = (body = sealedPost()) =>
    app.request(`${operatorOrigins.staging}${sealedRoutePath}`, {
      method: "POST",
      headers: {
        ...sealedPartHeaders,
        authorization: `Bearer ${grantBearer}`,
        cookie: marker,
        "x-forwarded-authorization": "Bearer hostile-forwarded-token",
      },
      body: JSON.stringify(body),
    });
  const response = await post();
  expect(response.status).toBe(200);
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    provenance,
    context: { audit: { performedByUserId: provenance.creatorUserId } },
  });
  fail = true;
  const failed = await post();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ code: "source-observations-unavailable" });
  for (const field of ["productName", "setName", "productLineName"] as const) {
    const hostile = sealedPost();
    hostile.products[0]![field] = marker;
    expect((await post(hostile)).status).toBe(400);
  }
  expect(received).toHaveLength(2);
  const evidence = JSON.stringify({ response: await response.text(), received, queries, logs });
  for (const value of [marker, "hostile-forwarded-token", grantBearer]) expect(evidence).not.toContain(value);
});
