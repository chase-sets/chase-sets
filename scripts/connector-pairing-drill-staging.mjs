// Composes the `pairing-drill:staging` command: the product drill entry plus the delivery-owned deploy-authority
// adapter. Staging persona sign-in supplies `signIn`; until it does, a pairing run refuses
// `connector-drill-sign-in-unavailable` before any read, and only `--smoke` can run.
import { resolve } from "node:path";
import { PairingDrillRefusal } from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill.ts";
import {
  runStagingDrill,
  stagingReceiptComment,
} from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill-staging.ts";
import { readConnectorDrillDeployBinding } from "./connector-pairing-drill-deploy-binding.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";

const root = resolve(import.meta.dirname, "..");

try {
  acquireHeavySlot("playwright");
  const { receipt } = await runStagingDrill(process.argv.slice(2), {
    resolveDeployBinding: (request) => readConnectorDrillDeployBinding(request),
    dist: resolve(root, "artifacts/connector-extension/staging"),
    outputDir: resolve(root, "artifacts/connector-pairing-drill", new Date().toISOString().replace(/[:.]/g, "-")),
  });
  process.stdout.write(stagingReceiptComment(receipt));
} catch (error) {
  if (!(error instanceof PairingDrillRefusal)) throw error;
  process.stderr.write(`${error.code}\n${JSON.stringify(error.evidence)}\n`);
  process.exitCode = 1;
}
