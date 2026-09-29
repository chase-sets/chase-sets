import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { PricingSqlAuthorityCommand } from "../api/listing-authority-sql";

// Deterministic transaction transport, not PostgreSQL certification. Commit loss happens AFTER durability.
export function sqlFixture<T>(
  initial: T,
  extra: (state: T, sql: string, values: readonly unknown[]) => { rows: unknown[]; rowCount?: number } = () => {
    throw new Error("Unexpected synthetic SQL");
  },
) {
  type Receipt = { command: PricingSqlAuthorityCommand; result: JsonValue };
  let durable = { data: initial, receipts: new Map<string, Receipt>() };
  let transaction: typeof durable | null = null;
  let loseCommit = false;
  const statements: string[] = [];
  const query: PgTransactionalPool["query"] = async <Row>(sql: string, values: readonly unknown[] = []) => {
    statements.push(sql);
    let rows: unknown[] = [];
    let rowCount: number | undefined;
    if (sql === "BEGIN") {
      if (transaction) throw new Error("Synthetic transaction overlap");
      transaction = structuredClone(durable);
    } else if (sql === "COMMIT") {
      durable = transaction!;
      transaction = null;
      if (loseCommit) {
        loseCommit = false;
        throw new Error("Synthetic lost commit reply");
      }
    } else if (sql === "ROLLBACK") transaction = null;
    else if (sql.includes("pg_advisory_xact_lock")) {
      if (!transaction) throw new Error("Synthetic lock outside transaction");
    } else if (sql.startsWith("SELECT command, result FROM pricing_authority_sql_mutations")) {
      const receipt = (transaction ?? durable).receipts.get(String(values[0]));
      if (receipt) rows = [structuredClone(receipt)];
    } else if (sql.includes("INSERT INTO pricing_authority_sql_mutations")) {
      if (!transaction) throw new Error("Receipt outside transaction");
      transaction.receipts.set(String(values[0]), {
        command: JSON.parse(String(values[1])),
        result: JSON.parse(String(values[2])),
      });
    } else {
      const result = extra((transaction ?? durable).data, sql, values);
      rows = result.rows;
      rowCount = result.rowCount;
    }
    return { rows: rows as Row[], rowCount };
  };
  const pool: PgTransactionalPool = { query, connect: async () => ({ query, release() {} }) };
  return {
    pool,
    statements,
    get data() {
      return durable.data;
    },
    get receipts() {
      return durable.receipts;
    },
    get inTransaction() {
      return transaction !== null;
    },
    loseNextCommit() {
      loseCommit = true;
    },
  };
}
