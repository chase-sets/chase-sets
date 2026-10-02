import { expect, it, vi } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { createTcgplayerAutomationRuntime } from "../api/runtime";
import type { TcgplayerAutomationStageFact } from "../../source-observations/api/providers/tcgplayer-automation-client";
import { describeDb, keyring, session, useOperatorSessionDatabase } from "./db-fixture";

describeDb("operator-session factory hot reload", () => {
  const db = useOperatorSessionDatabase("operator_session_hot_reload");

  it("uses one credential resolution per request for both headers and facts without rebuilding clients", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
    );
    const queries: string[] = [];
    const pool: PgQueryable = {
      async query<Row>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
        queries.push(sql);
        return db().query<Row>(sql, values);
      },
    };
    const runtime = createTcgplayerAutomationRuntime({ pool, config: null, keyring }, { fetch })!;
    expect(queries).toEqual([]);
    await runtime.store.accept(session(0, "first"));
    const facts: TcgplayerAutomationStageFact[] = [];
    queries.length = 0;
    await runtime.httpClients.infiniteApi.get("/synthetic", {}, { onStage: (fact) => facts.push(fact) });
    expect(queries.filter((sql) => sql.startsWith("SELECT * FROM catalog_tcgplayer_operator_sessions"))).toHaveLength(
      1,
    );
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("Cookie")).toBe("TCGAuthTicket_Production=first;");
    expect(facts.at(-1)).toMatchObject({ outcome: "success", credential: { source: "operator-session", revision: 1 } });
    await runtime.store.accept(session(1, "second"));
    facts.length = 0;
    queries.length = 0;
    await runtime.httpClients.infiniteApi.get("/synthetic", {}, { onStage: (fact) => facts.push(fact) });
    expect(queries.filter((sql) => sql.startsWith("SELECT * FROM catalog_tcgplayer_operator_sessions"))).toHaveLength(
      1,
    );
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get("Cookie")).toBe("TCGAuthTicket_Production=second;");
    expect(facts.at(-1)).toMatchObject({ credential: { source: "operator-session", revision: 2 } });
  });
});
