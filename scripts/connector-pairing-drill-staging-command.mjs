import { resolve } from "node:path";
import { runStagingDrill } from "../deployables/tcgplayer-connector-extension/e2e/pairing-drill-staging.ts";
import {
  ghApi,
  readConnectorDrillDeployBinding,
  readStagingSignInReceiptFloor,
} from "./connector-pairing-drill-deploy-binding.mjs";

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
