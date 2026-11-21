import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createPgPool,
  ManagedPostgresClientError,
  type PgTransactionalPool,
} from "../infrastructure/event-core-postgres/index.ts";
import {
  completionManifestFilename,
  completionManifestWindow,
  produceProductionCatalogCompletionManifest,
} from "../bounded-contexts/catalog/features/completion-report/read-model/freeze-manifest.ts";
import { ProductionCatalogCompletionFactsError } from "../bounded-contexts/catalog/features/completion-report/read-model/query.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      "batch-id": { type: "string" },
      "main-commit": { type: "string" },
      "launch-cutoff": { type: "string" },
      "expires-at": { type: "string" },
      "out-dir": { type: "string" },
    },
  });
  const outDir = values["out-dir"];
  if (!outDir) throw new Error("manifest-output-missing: --out-dir is required.");
  const window = completionManifestWindow(
    {
      batchId: values["batch-id"] ?? "",
      mainCommit: values["main-commit"] ?? "",
      launchCutoff: values["launch-cutoff"] ?? "",
      expiresAt: values["expires-at"] ?? "",
    },
    () => new Date(),
  );
  const databaseUrl = process.env.DATABASE_URL_CATALOG;
  if (!databaseUrl) throw new Error("catalog-database-url-missing: the Catalog context URL was not exported.");
  const pool = createPgPool(databaseUrl, { max: 1 });
  try {
    const artifact = await produceProductionCatalogCompletionManifest(pool, window);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, completionManifestFilename), artifact.json, { flag: "wx" });
    writeFileSync(
      join(outDir, `${completionManifestFilename}.sha256`),
      `${artifact.sha256}  ${completionManifestFilename}\n`,
      { flag: "wx" },
    );
  } finally {
    await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // Unclassified database and filesystem errors can include sensitive connection or row data.
    const reason =
      error instanceof ManagedPostgresClientError
        ? error.classification
        : error instanceof ProductionCatalogCompletionFactsError
          ? error.code
          : error instanceof Error &&
              /^(manifest-plan-drift|manifest-window-invalid|manifest-output-missing|catalog-database-url-missing):/.test(
                error.message,
              )
            ? error.message
            : "Check the input format, batch existence, and Catalog database authority.";
    console.error(`Catalog completion manifest not written: ${reason}`);
    process.exitCode = 1;
  });
}
