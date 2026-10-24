import { expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as catalogModule } from "../../../index";
import { database, describeDb } from "./db-fixture";

describeDb("operator session revoke reasons", () => {
  const db = database("operator_grant_revoke_reason");

  it("accepts authority-lost on fresh bootstrap and remains inert on rerun", async () => {
    const pool = db();
    await bootstrapContextDatabase(catalogModule, pool);
    const first = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'catalog_operator_session_grants'::regclass
          AND conname = 'catalog_operator_session_grants_revoke_reason_check'`,
    );
    expect(first.rows[0]?.definition).toContain("authority-lost");
    await bootstrapContextDatabase(catalogModule, pool);
    const second = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'catalog_operator_session_grants'::regclass
          AND conname = 'catalog_operator_session_grants_revoke_reason_check'`,
    );
    expect(second.rows).toEqual(first.rows);
  });
});
