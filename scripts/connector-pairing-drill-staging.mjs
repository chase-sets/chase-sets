// Composes the `pairing-drill:staging` command: the product drill entry plus the delivery-owned deploy-authority
// adapter. The staging bearer is removed from the environment before admission,
// deploy reads or browser launch; only the in-memory adapter may use it once.
import { resolve } from "node:path";
import { PairingDrillRefusal } from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill.ts";
import {
  createStagingPersonaSignIn,
  runStagingDrill,
  stagingReceiptComment,
} from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill-staging.ts";
import { readConnectorDrillDeployBinding } from "./connector-pairing-drill-deploy-binding.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";

const root = resolve(import.meta.dirname, "..");
const signIn = createStagingPersonaSignIn();

try {
  acquireHeavySlot("playwright");
  const { receipt } = await runStagingDrill(process.argv.slice(2), {
    resolveDeployBinding: (request) => readConnectorDrillDeployBinding(request),
    signIn,
    dist: resolve(root, "artifacts/connector-extension/staging"),
    outputDir: resolve(root, "artifacts/connector-pairing-drill", new Date().toISOString().replace(/[:.]/g, "-")),
  });
  process.stdout.write(stagingReceiptComment(receipt));
} catch (error) {
  if (!(error instanceof PairingDrillRefusal)) throw error;
  process.stderr.write(`${error.code}\n${JSON.stringify(error.evidence)}\n`);
  process.exitCode = 1;
}
