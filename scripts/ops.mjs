#!/usr/bin/env node
// Single entry point for operational evidence/readiness/canary scripts. Usage:
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
  "design-system:legacy-evidence": {
    script: "design-system-legacy-evidence.mjs",
    description: "Design-system legacy visual/accessibility evidence record.",
  },
  "design-system:legacy-inventory": {
    script: "design-system-legacy-inventory.mjs",
    description: "Inventory of legacy design-system surfaces and ledger writer.",
  },
  "design-system:raw-ui-budget": {
    script: "design-system-raw-ui-budget.mjs",
    description: "Ratcheted raw UI budgets for bounded-context and deployable consumers.",
  },
  "admin-workflows:qa-evidence": {
    script: "admin-workflows-qa-evidence.mjs",
    description: "Lint admin-workflows QA evidence for public redaction safety.",
  },
  "account-cart:consistency-probe": {
    script: "account-cart-consistency-probe.mjs",
    description: "Redacted account-cart post-write consistency probe evidence.",
  },
  "campaign:start-gate": {
    script: "campaign-start-gate.mjs",
    description: "Campaign-start checklist gate for the beta-signup surface.",
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
  "checkout:order-readiness-trace": {
    script: "checkout-order-readiness-trace.mjs",
    description: "Redacted staging checkout order-readiness trace for payment-start blockers.",
  },
  "guest-buy-now:freshness-probe": {
    script: "guest-buy-now-freshness-probe.mjs",
    description: "Guest buy-now freshness probe against a deployed environment.",
  },
  "launch:go-no-go-gate": {
    script: "launch-go-no-go-gate.mjs",
    description: "Aggregate terminal launch-evidence go/no-go gate and recorded decision.",
  },
  "marketplace:checkout-fee-evidence": {
    script: "marketplace-checkout-fee-evidence.mjs",
    description: "Checkout fee policy approval evidence.",
  },
  "marketplace:easypost-refund-event-replay": {
    script: "easypost-refund-event-replay.mjs",
    description: "Replay EasyPost refund events into fulfillment.",
  },
  "marketplace:fulfillment-postage-evidence": {
    script: "marketplace-fulfillment-postage-evidence.mjs",
    description: "Fulfillment postage launch gate evidence.",
  },
  "marketplace:launch-supply-measurement": {
    script: "marketplace-launch-supply-measurement.mjs",
    description: "Measure launch supply coverage for the marketplace.",
  },
  "marketplace:production-env-commands": {
    script: "marketplace-production-env-commands.mjs",
    description: "Production environment variable commands from a production environment JSON record.",
  },
  "marketplace:production-env-snapshot": {
    script: "marketplace-production-env-snapshot.mjs",
    description: "Snapshot production environment variables for launch evidence.",
  },
  "marketplace:production-launch-readiness": {
    script: "marketplace-production-launch-readiness.mjs",
    description: "Production launch readiness gate from variables and secrets.",
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
  "projection:hot-lag-evidence": {
    script: "projection-hot-lag-evidence.mjs",
    description: "Support-safe hot projection lag attribution evidence for projection worker pressure.",
  },
  "postgres:growth-evidence": {
    script: "postgres-growth-evidence.mjs",
    description: "Support-safe Postgres growth and relation-size evidence.",
  },
  "postgres:slow-query-digest": {
    script: "postgres-slow-query-digest.mjs",
    description: "Support-safe pg_stat_statements slow-query aggregate digest.",
  },
  "read-consistency:route-matrix-evidence": {
    script: "read-consistency-route-matrix-evidence.mjs",
    description: "Prometheus-backed read-consistency route matrix freshness evidence.",
  },
  "read-consistency:route-matrix-sampler": {
    script: "read-consistency-route-matrix-sampler.mjs",
    description: "Support-safe staging route-matrix sampler and blocker artifact.",
  },
  "read-consistency:route-matrix-deploy-window": {
    script: "read-consistency-route-matrix-deploy-window.mjs",
    description: "Support-safe staging route-matrix deploy-window state artifact.",
  },
  "push-wake:capacity-evidence": {
    script: "push-wake-capacity-evidence.mjs",
    description: "CI-safe push-wake connection budget and listener expansion evidence.",
  },
  "push-wake:load-evidence": {
    script: "push-wake-load-evidence.mjs",
    description: "No-secret budget evaluation for captured push-wake load artifacts.",
  },
  "pr-release:status": {
    script: "pr-release-status.mjs",
    description: "Render PR release status markdown.",
  },
  "release-health:ci-metadata": {
    script: "release-health-ci-metadata.mjs",
    description: "Release health CI metadata record.",
  },
  "release-health:flake-digest": {
    script: "release-health-flake-digest.mjs",
    description: "Weekly CI flake digest from GitHub Actions retry telemetry.",
  },
  "release-health:merge-group-failure-signatures": {
    script: "release-health-merge-group-failure-signatures.mjs",
    description: "Read-only merge-group failure signature deduplication and attribution report.",
  },
  "release-health:merge-queue-posture": {
    script: "release-health-merge-queue-posture.mjs",
    description: "Read-only merge-queue ruleset posture against the checked-in release policy.",
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
  "rollback:staging-drill": {
    script: "digitalocean-staging-rollback-drill.mjs",
    description: "Run the staging-only App Platform rollback drill.",
  },
  "wake:drills": {
    script: "staging-wake-drills.mjs",
    description: "Run staging wake recovery drills.",
  },
  "wake:mixed-version-drill": {
    script: "staging-mixed-version-wake-drill.mjs",
    description: "Evaluate staging mixed-version wake drill evidence.",
  },
  "worktree:add": {
    script: "worktree-add.mjs",
    description: "Add a pooled worktree with strict name/branch validation.",
  },
};

export const ROOT_SCRIPT_COMMANDS = {
  "setup:worktree": "Install workspace dependencies for the current worktree.",
  "dev:bootstrap": "Prepare the local sandbox databases and runtime state.",
  dev: "Start the full local sandbox system.",
  "dev:down": "Stop this worktree's local sandbox.",
  "dev:db:refresh": "Recreate this worktree's local databases and bootstrap again.",
  "sandbox:doctor": "Print active sandbox ports, URLs, and health hints.",
  "sandbox:clean": "Remove this worktree's sandbox containers and volumes.",
  "test:scripts": "Run repository script/tooling tests.",
  "test:structure": "Run architecture and structure guardrail tests.",
  "test:typecheck:watch": "Watch TypeScript coverage for repository test files.",
  typecheck: "Run no-any plus TypeScript checks.",
  "typecheck:watch": "Watch TypeScript coverage for repository source files.",
  "verify:static": "Run formatting, static checks, structure checks, and script tests.",
  "replay:projection": "Inspect or rebuild deployable projection groups.",
  "smoke:platform": "Run platform smoke checks for deployed hosts.",
  "wake:drills": "Run staging wake recovery drills.",
  "wake:mixed-version-drill": "Run staging mixed-version wake drills.",
  "stripe:money-smoke": "Run Stripe money smoke evidence tooling.",
};

export function renderHelp() {
  const names = Object.keys(SUBCOMMANDS).sort();
  const width = Math.max(...names.map((name) => name.length));
  const rootScriptNames = Object.keys(ROOT_SCRIPT_COMMANDS).sort();
  const rootScriptWidth = Math.max(...rootScriptNames.map((name) => name.length));
  const lines = [
    "Usage: node ./scripts/ops.mjs <subcommand> [args...]",
    "",
    "Operational evidence/readiness/canary commands. Arguments after the",
    "subcommand are passed through to the underlying script unchanged.",
    "",
    "Subcommands:",
    ...names.map((name) => `  ${name.padEnd(width)}  ${SUBCOMMANDS[name].description}`),
    "",
    "Root pnpm scripts:",
    ...rootScriptNames.map((name) => `  pnpm run ${name.padEnd(rootScriptWidth)}  ${ROOT_SCRIPT_COMMANDS[name]}`),
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
