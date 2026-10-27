import { resolve } from "node:path";
import {
  parsePairingDrillStagingArgs,
  runPairingDrillStaging,
} from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill-staging.ts";
import { readDeployBinding } from "./connector-pairing-drill-deploy-binding.mjs";
import { PairingDrillRefusal } from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill.ts";

const args = parsePairingDrillStagingArgs(process.argv.slice(2));
const result = await runPairingDrillStaging(args, {
  dist: resolve(import.meta.dirname, "../deployables/tcgplayer-connector-extension/dist"),
  resolveDeployBinding: async (run, commit) => readDeployBinding(run, commit),
  signIn: async () => {
    throw new PairingDrillRefusal("connector-drill-sign-in-unavailable", {
      forwardCount: 0,
      forwards: [],
      requests: [],
      lifecycle: [],
    });
  },
  preparePairing: async () => {
    throw new Error("connector-drill-sign-in-unavailable");
  },
  revoke: async () => undefined,
});
process.stdout.write(`${JSON.stringify(result.receipt)}\n`);
