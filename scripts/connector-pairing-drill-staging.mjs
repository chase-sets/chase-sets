// Composes the `pairing-drill:staging` command: the product drill entry plus the delivery-owned deploy-authority
// adapter. The staging bearer is removed from the environment before admission,
// deploy reads or browser launch; only the in-memory adapter may use it once.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PairingDrillRefusal } from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill.ts";
import {
  createStagingPersonaSignIn,
  runStagingDrill,
  stagingReceiptComment,
} from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill-staging.ts";
import {
  ghApi,
  readConnectorDrillDeployBinding,
  readStagingSignInReceiptFloor,
} from "./connector-pairing-drill-deploy-binding.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";

const root = resolve(import.meta.dirname, "..");

export function runStagingDrillCommand(argv, { gh = ghApi, now, ...ports } = {}) {
  return runStagingDrill(argv, {
    dist: resolve(root, "artifacts/connector-extension/staging"),
    outputDir: resolve(root, "artifacts/connector-pairing-drill", new Date().toISOString().replace(/[:.]/g, "-")),
    ...ports,
    resolveDeployBinding: (request) =>
      readConnectorDrillDeployBinding(request, {
        gh,
        now,
        readReceiptFloor: (authority) => readStagingSignInReceiptFloor(authority, { gh }),
      }),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const signIn = createStagingPersonaSignIn();
  try {
    acquireHeavySlot("playwright");
    const { receipt } = await runStagingDrillCommand(process.argv.slice(2), { signIn });
    process.stdout.write(stagingReceiptComment(receipt));
  } catch (error) {
    if (!(error instanceof PairingDrillRefusal)) throw error;
    process.stderr.write(`${error.code}\n${JSON.stringify(error.evidence)}\n`);
    process.exitCode = 1;
  }
}
