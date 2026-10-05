import { runStructureCheck } from "./check-structure/run.mjs";

const result = await runStructureCheck();
if (process.argv.includes("--json-import-inventory")) {
  console.log(`JSON_IMPORT_INVENTORY ${JSON.stringify(result.jsonImportInventory)}`);
}
