#!/usr/bin/env node
// Single entry point for the operational evidence/readiness/canary/launch
// scripts (issue #1331). Usage:
//
//   node ./scripts/ops.mjs <subcommand> [args...]
//   pnpm run ops <subcommand> [args...]
//
// Each subcommand maps to an existing standalone script in scripts/ and is
// executed in a child Node process, so every underlying script keeps working
// when invoked directly. Adding a new operational check means adding one row
// to SUBCOMMANDS below — not a new root package.json script.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

export const SUBCOMMANDS = {
  "account-canary:evidence": {
    script: "account-canary-evidence.mjs",
    description: "Deterministic account-cohort canary evidence record.",
  },
  "canary:analysis": {
    script: "canary-analysis.mjs",
    description: "Analyze canary telemetry and emit a promotion decision.",
  },
  "canary:evidence": {
    script: "canary-evidence.mjs",
    description: "Collect canary observation-window evidence for a release commit.",
  },
  "design-system:legacy-evidence": {
    script: "design-system-legacy-evidence.mjs",
    description: "Design-system legacy visual/accessibility evidence record.",
  },
  "design-system:legacy-inventory": {
    script: "design-system-legacy-inventory.mjs",
    description: "Inventory of legacy design-system surfaces and ledger writer.",
  },
  "emergency-recovery:guide": {
    script: "emergency-recovery-guide.mjs",
    description: "Emergency recovery guide record for platform incidents.",
  },
  "google-shopping:crawl-posture-evidence": {
    script: "google-shopping-crawl-posture-evidence.mjs",
    description: "Google Shopping crawl posture evidence for the marketplace host.",
  },
  "google-shopping:launch-readiness-evidence": {
    script: "google-shopping-launch-readiness-evidence.mjs",
    description: "Google Shopping launch readiness gate evidence.",
  },
  "guest-buy-now:freshness-canary": {
    script: "guest-buy-now-freshness-canary.mjs",
    description: "Guest buy-now freshness canary against a deployed environment.",
  },
  "marketplace:checkout-fee-evidence": {
    script: "marketplace-checkout-fee-evidence.mjs",
    description: "Checkout fee policy approval evidence.",
  },
  "marketplace:deferred-checkout-order-proof": {
    script: "marketplace-deferred-checkout-order-proof.mjs",
    description: "Deferred checkout order proof from a live checkout request.",
  },
  "marketplace:easypost-refund-event-replay": {
    script: "easypost-refund-event-replay.mjs",
    description: "Replay EasyPost refund events into fulfillment.",
  },
  "marketplace:fulfillment-postage-evidence": {
    script: "marketplace-fulfillment-postage-evidence.mjs",
    description: "Fulfillment postage launch gate evidence.",
  },
  "marketplace:launch-evidence": {
    script: "marketplace-launch-evidence.mjs",
    description: "Verify the redacted marketplace launch evidence packet.",
  },
  "marketplace:launch-packet": {
    script: "marketplace-launch-packet.mjs",
    description: "Assemble the marketplace launch packet.",
  },
  "marketplace:launch-supply-measurement": {
    script: "marketplace-launch-supply-measurement.mjs",
    description: "Measure launch supply coverage for the marketplace.",
  },
  "marketplace:production-env-commands": {
    script: "marketplace-production-env-commands.mjs",
    description: "Production environment variable commands from a launch packet.",
  },
  "marketplace:production-env-snapshot": {
    script: "marketplace-production-env-snapshot.mjs",
    description: "Snapshot production environment variables for launch evidence.",
  },
  "marketplace:production-launch-readiness": {
    script: "marketplace-production-launch-readiness.mjs",
    description: "Production launch readiness gate from variables and secrets.",
  },
  "marketplace:production-proof-readiness": {
    script: "marketplace-production-proof-readiness.mjs",
    description: "Production proof-mode readiness record and operator setup manifest.",
  },
  "marketplace:production-proof-topology-evidence": {
    script: "marketplace-production-proof-topology-evidence.mjs",
    description: "Production proof topology evidence against the deployed host.",
  },
  "marketplace:promotion-evidence": {
    script: "marketplace-promotion-evidence.mjs",
    description: "Marketplace public promotion review evidence.",
  },
  "marketplace:provider-proof-status": {
    script: "marketplace-provider-proof-status.mjs",
    description: "Provider proof status report from payments/settlement/fulfillment data.",
  },
  "marketplace:public-presence-copy-audit": {
    script: "marketplace-public-presence-copy-audit.mjs",
    description: "Audit public presence copy for launch readiness.",
  },
  "marketplace:stripe-money-operations-evidence": {
    script: "marketplace-stripe-money-operations-evidence.mjs",
    description: "Stripe money operations launch gate evidence.",
  },
  "marketplace:support-operations-evidence": {
    script: "marketplace-support-operations-evidence.mjs",
    description: "Support operations readiness evidence.",
  },
  "marketplace:tax-nexus-measurement": {
    script: "marketplace-tax-nexus-measurement.mjs",
    description: "Measure tax nexus exposure for the marketplace.",
  },
  "marketplace:tax-readiness-evidence": {
    script: "marketplace-tax-readiness-evidence.mjs",
    description: "Production tax readiness gate evidence.",
  },
  "marketplace:transactional-email-evidence": {
    script: "marketplace-transactional-email-evidence.mjs",
    description: "Transactional email launch gate evidence.",
  },
  "postage-policy:cleanup-evidence": {
    script: "postage-policy-cleanup-evidence.mjs",
    description: "Postage policy cleanup evidence from ordering/fulfillment data.",
  },
  "pr-release:status": {
    script: "pr-release-status.mjs",
    description: "Render PR release status markdown.",
  },
  "release-health:ci-metadata": {
    script: "release-health-ci-metadata.mjs",
    description: "Release health CI metadata record.",
  },
  "release-health:report": {
    script: "release-health-report.mjs",
    description: "Aggregate release health artifacts into a summary report.",
  },
  "release-lock:commands": {
    script: "release-lock-commands.mjs",
    description: "Release lock/unlock commands for an environment.",
  },
  "rollback:readiness": {
    script: "rollback-readiness.mjs",
    description: "Rollback readiness gate record.",
  },
  "settlement:payout-account-migration-report": {
    script: "settlement-payout-account-migration-report.mjs",
    description: "Settlement payout account migration report.",
  },
  "wake:drills": {
    script: "staging-wake-drills.mjs",
    description: "Run staging wake recovery drills.",
  },
  "worktree:add": {
    script: "worktree-add.mjs",
    description: "Add a pooled worktree with strict name/branch validation.",
  },
};

export function renderHelp() {
  const names = Object.keys(SUBCOMMANDS).sort();
  const width = Math.max(...names.map((name) => name.length));
  const lines = [
    "Usage: node ./scripts/ops.mjs <subcommand> [args...]",
    "",
    "Operational evidence/readiness/canary commands. Arguments after the",
    "subcommand are passed through to the underlying script unchanged.",
    "",
    "Subcommands:",
    ...names.map((name) => `  ${name.padEnd(width)}  ${SUBCOMMANDS[name].description}`),
    "",
    "Run `node ./scripts/ops.mjs help` to show this list.",
  ];
  return lines.join("\n");
}

export function parseOpsArgs(argv) {
  const args = [...argv];
  // pnpm/npm compatibility: tolerate `pnpm run ops -- <subcommand> -- <args>`.
  if (args[0] === "--") {
    args.shift();
  }
  const subcommand = args.shift() ?? null;
  if (args[0] === "--") {
    args.shift();
  }
  return { subcommand, args };
}

function runSubcommand(entry, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(scriptsDir, entry.script), ...args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve(signal ? 1 : (code ?? 0));
    });
  });
}

async function main(argv) {
  const { subcommand, args } = parseOpsArgs(argv);

  if (subcommand === null) {
    console.error(renderHelp());
    return 2;
  }
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(renderHelp());
    return 0;
  }

  const entry = SUBCOMMANDS[subcommand];
  if (!entry) {
    console.error(`Unknown ops subcommand: ${subcommand}\n`);
    console.error(renderHelp());
    return 2;
  }

  try {
    return await runSubcommand(entry, args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
