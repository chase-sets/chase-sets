import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { module as catalogModule } from "../../../index";
import { catalogAuthoringSchemaMigrations, catalogAuthoringSchemaSql } from "../../../support/authoring-support/schema";
import { catalogOperatorSessionSchemaMigrations, catalogOperatorSessionSchemaSql } from "../read-model/schema";
import {
  catalogOperatorSessionGrantSchemaMigrations,
  catalogOperatorSessionGrantSchemaSql,
} from "../read-model/grant-schema";

describe("operator-session schema enrollment", () => {
  it("registers identical additive boot DDL and a ledger migration in the existing module registry", () => {
    expect(catalogAuthoringSchemaSql).toContain(catalogOperatorSessionSchemaSql);
    expect(catalogOperatorSessionSchemaMigrations[0]!.statements).toEqual([catalogOperatorSessionSchemaSql]);
    expect(catalogAuthoringSchemaMigrations).toContain(catalogOperatorSessionSchemaMigrations[0]);
    expect(catalogModule.schemaMigrations).toEqual(expect.arrayContaining([...catalogOperatorSessionSchemaMigrations]));
    const reset = readFileSync(
      new URL("../../source-observations/api/governance/catalog-integration-data-migration-reset.ts", import.meta.url),
      "utf8",
    );
    expect(reset).not.toContain("catalog_tcgplayer_operator_sessions");
    expect(reset).not.toContain("catalog_operator_session_grants");
    expect(catalogAuthoringSchemaSql).toContain(catalogOperatorSessionGrantSchemaSql);
    expect(catalogOperatorSessionGrantSchemaMigrations[0]!.statements).toEqual([
      catalogOperatorSessionGrantSchemaSql,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS catalog_operator_session_one_unrevoked
  ON catalog_operator_session_grants ((true)) WHERE revoked_at IS NULL;`,
      `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index WHERE indexrelid = 'catalog_operator_session_one_unrevoked'::regclass
      AND indisvalid AND indisunique
  ) THEN
    RAISE EXCEPTION 'operator session grant index unavailable';
  END IF;
END $$;`,
    ]);
    expect(catalogModule.schemaMigrations).toEqual(
      expect.arrayContaining([...catalogOperatorSessionGrantSchemaMigrations]),
    );
    expect(catalogOperatorSessionGrantSchemaSql).toContain("octet_length(token_hash) = 32");
    expect(catalogOperatorSessionGrantSchemaMigrations[0]!.statements[1]).toContain(
      "((true)) WHERE revoked_at IS NULL",
    );
  });
  it("enrolls every DB suite without running it in the database-free profile", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    for (const name of ["operator-session-store-fence", "operator-session-hot-reload", "operator-session-precedence"]) {
      const path = `features/operator-session/tests/${name}.db.test.ts`;
      expect(manifest.scripts["test:db"]).toContain(path);
      expect(manifest.scripts["test:unit"]).toContain(`--exclude ${path}`);
      expect(manifest.scripts["test:fast"]).toContain(`--exclude ${path}`);
    }
  });
});
