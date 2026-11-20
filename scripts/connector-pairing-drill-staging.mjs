// Composes the `pairing-drill:staging` command: the product drill entry plus the delivery-owned deploy-authority
// adapter. The staging bearer is removed from the environment before admission,
// deploy reads or browser launch; only the in-memory adapter may use it once.
import { PairingDrillRefusal } from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill.ts";
import {
  createStagingPersonaSignIn,
  stagingReceiptComment,
} from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill-staging.ts";
import { runStagingDrillCommand } from "./connector-pairing-drill-staging-command.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";

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
