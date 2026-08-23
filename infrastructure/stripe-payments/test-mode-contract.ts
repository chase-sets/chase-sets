#!/usr/bin/env node
/**
 * Bounded Stripe test-mode contract verifier for SetupIntent cancellation.
 * Creates three unmistakably synthetic SetupIntents (no customer, no real
 * identity), exercises the shipped `cancelSetupSession` candidate against
 * each, and writes a bounded, redacted artifact -- never a provider id,
 * secret, body, or credential -- only after every object is confirmed
 * terminal `canceled`.
 *
 * This script never touches live-mode authority: it refuses to run unless
 * `STRIPE_SECRET_KEY` is shaped as a test-mode key, and it refuses every
 * response that does not itself confirm `livemode: false`.
 */
import process from "node:process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createStripePaymentProcessorGateway } from "./index";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";

const SUBCOMMANDS = ["cancel-setup-intent"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

type SetupIntentCaseLabel = "requires_payment_method" | "requires_confirmation" | "requires_action";

type SetupIntentCaseSpec = Readonly<{
  label: SetupIntentCaseLabel;
  createBody: Readonly<Record<string, string>>;
}>;

const SYNTHETIC_PROBE_TAG = "chase-sets-6732-cancel-setup-intent";

const CASES: readonly SetupIntentCaseSpec[] = [
  {
    label: "requires_payment_method",
    createBody: {
      usage: "off_session",
      "payment_method_types[0]": "card",
      "metadata[chase_sets_synthetic_probe]": SYNTHETIC_PROBE_TAG,
    },
  },
  {
    label: "requires_confirmation",
    createBody: {
      usage: "off_session",
      "payment_method_types[0]": "card",
      payment_method: "pm_card_visa",
      "metadata[chase_sets_synthetic_probe]": SYNTHETIC_PROBE_TAG,
    },
  },
  {
    label: "requires_action",
    createBody: {
      usage: "off_session",
      "payment_method_types[0]": "card",
      payment_method: "pm_card_authenticationRequired",
      confirm: "true",
      "metadata[chase_sets_synthetic_probe]": SYNTHETIC_PROBE_TAG,
    },
  },
];

type CaseResult = Readonly<{
  initialStatus: SetupIntentCaseLabel;
  observedInitialStatus: string;
  firstOutcome: string;
  firstProcessorStatus: string | null;
  secondOutcome: string;
  secondProcessorStatus: string | null;
  terminalStatus: string;
  cancelWriteCount: number;
  livemode: false;
}>;

function readOption(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index >= 0) {
    return argv[index + 1]?.trim() || null;
  }
  return null;
}

function toFormBody(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  if (!subcommand || !(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new Error(`Usage: test-mode-contract.ts <${SUBCOMMANDS.join("|")}> --output <path>`);
  }

  const outputPath = readOption(args, "--output");
  if (!outputPath) {
    throw new Error("--output <path> is required.");
  }

  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. This probe requires the normal secure Stripe test-mode credential " +
        "supplied through the environment; it never requests or uses live-mode authority.",
    );
  }
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error(
      "STRIPE_SECRET_KEY is not shaped as a Stripe test-mode secret key. Refusing to run before any network call.",
    );
  }

  const apiBaseUrl = process.env.STRIPE_API_BASE_URL?.trim() || "https://api.stripe.com";
  const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;

  async function rawStripeRequest(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    headers.set("Stripe-Version", STRIPE_API_VERSION);
    const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !body) {
      throw new Error(`Stripe request to '${path}' failed with status ${response.status}.`);
    }
    if (body.livemode !== false) {
      throw new Error(`Stripe response for '${path}' did not confirm livemode: false; refusing to qualify.`);
    }
    return body;
  }

  const gateway = createStripePaymentProcessorGateway({
    secretKey,
    publishableKey: "pk_test_unused",
    webhookSecret: "whsec_unused",
    apiBaseUrl,
  });

  const results: CaseResult[] = [];

  for (const caseSpec of CASES) {
    const created = await rawStripeRequest("/v1/setup_intents", {
      method: "POST",
      body: toFormBody(caseSpec.createBody),
    });
    const reference = typeof created.id === "string" ? created.id : null;
    const observedInitialStatus = typeof created.status === "string" ? created.status : "unknown";
    if (!reference || observedInitialStatus !== caseSpec.label) {
      throw new Error(
        `Synthetic SetupIntent for '${caseSpec.label}' did not reach the expected initial status ` +
          `(observed '${observedInitialStatus}'). Refusing to qualify from ambiguous state.`,
      );
    }

    const first = await gateway.cancelSetupSession(reference);
    if (first.outcome !== "cancelled" || first.processorStatus !== "canceled") {
      throw new Error(
        `Candidate cancellation for '${caseSpec.label}' did not observe cancelled/canceled on the first call ` +
          `(outcome '${first.outcome}'). Refusing to qualify from ambiguous state.`,
      );
    }

    const second = await gateway.cancelSetupSession(reference);
    if (second.outcome !== "already-terminal" || second.processorStatus !== "canceled") {
      throw new Error(
        `Candidate cancellation for '${caseSpec.label}' did not observe already-terminal/canceled on the repeat ` +
          `call (outcome '${second.outcome}'). Refusing to qualify from ambiguous state.`,
      );
    }

    const terminal = await rawStripeRequest(`/v1/setup_intents/${encodeURIComponent(reference)}`, {
      method: "GET",
    });
    const terminalStatus = typeof terminal.status === "string" ? terminal.status : "unknown";
    if (terminalStatus !== "canceled") {
      throw new Error(
        `Synthetic SetupIntent for '${caseSpec.label}' did not retrieve terminal 'canceled' status ` +
          `(observed '${terminalStatus}'). Refusing to publish before terminal rollback is confirmed.`,
      );
    }

    results.push({
      initialStatus: caseSpec.label,
      observedInitialStatus,
      firstOutcome: first.outcome,
      firstProcessorStatus: "processorStatus" in first ? first.processorStatus : null,
      secondOutcome: second.outcome,
      secondProcessorStatus: "processorStatus" in second ? second.processorStatus : null,
      terminalStatus,
      cancelWriteCount: 1,
      livemode: false,
    });
  }

  const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const checkedAt = new Date().toISOString();

  const artifactBody = {
    schemaVersion: "stripe-setup-intent-cancel-test-mode-contract/v1",
    subcommand,
    apiVersion: STRIPE_API_VERSION,
    candidateHead,
    checkedAt,
    livemode: false as const,
    cases: results,
  };

  const digest = createHash("sha256").update(JSON.stringify(artifactBody)).digest("hex");
  const artifact = { ...artifactBody, digest };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  process.stdout.write(`Stripe setup-intent cancellation test-mode contract qualified: ${outputPath}\n`);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Stripe setup-intent cancellation test-mode contract failed: ${message}\n`);
  process.exitCode = 1;
});
