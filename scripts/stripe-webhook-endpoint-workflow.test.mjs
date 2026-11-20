import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createPaymentProcessorWebhookRoutes } from "../bounded-contexts/payments/features/payments/api/route.ts";
import { createPaymentWebhookRunner } from "../bounded-contexts/payments/features/payments/api/webhook-transaction.ts";
import { createStripePaymentProcessorGateway } from "../infrastructure/stripe-payments/index.ts";
import registry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };
import {
  STRIPE_PAYMENTS_WEBHOOK_ENVIRONMENTS,
  runStripePaymentsWebhookEndpointCommand,
} from "./stripe-webhook-endpoint.mjs";
import { STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS } from "./stripe-webhook-events.mjs";
import { PAYMENTS_PROVIDER_WEBHOOK_PATH } from "./provider-webhook-paths.mjs";

const workflow = readFileSync(
  resolve(".github/workflows/platform-production-stripe-webhook-endpoint-verify.yml"),
  "utf8",
);
const createWorkflow = readFileSync(
  resolve(".github/workflows/platform-production-stripe-webhook-endpoint-create.yml"),
  "utf8",
);
const createStep = parse(createWorkflow).jobs.create.steps.at(-1);
const captureName = "STRIPE_WEBHOOK_DELIVERY_CAPTURE";
const confirmation = "create production payments webhook endpoint";
const eventId = "evt_synthetic_endive_delivery";
const targetKey = "whsec_synthetic_target";
const oldKey = "whsec_synthetic_old";
const canonicalUrl = STRIPE_PAYMENTS_WEBHOOK_ENVIRONMENTS.production.canonicalBaseUrl + PAYMENTS_PROVIDER_WEBHOOK_PATH;

function runCompletionShell(directory, overrides = {}) {
  const bash =
    process.platform === "win32"
      ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe")
      : "bash";
  // Intercept only the executable boundary; use the actual workflow Bash block.
  const stub = `pnpm() {
    [[ ! -v STRIPE_WEBHOOK_DELIVERY_CAPTURE ]] || return 42
    printf '%s\\0' "$@"
    if [[ "\${@:(-2):1}" == --delivery-file ]]; then
      cp -- "\${@: -1}" "$RUNNER_TEMP/synthetic-proof.json" || return 43
    fi
    return "\${SYNTHETIC_EXIT:-0}"
  }`;
  return spawnSync(bash, ["--noprofile", "--norc"], {
    input: `${stub}\n${createStep.run}`,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
      RUNNER_TEMP: directory.replaceAll("\\", "/"),
      OPERATION: "replace-version",
      PHASE: "complete",
      CONFIRMATION: confirmation,
      DELIVERY_EVENT: eventId,
      USE_SIGNED_DELIVERY_CAPTURE: "false",
      [captureName]: "",
      ...overrides,
    },
  });
}

function signedEndiveDelivery() {
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({
    id: eventId,
    api_version: registry.apiVersion,
    livemode: true,
    created: timestamp,
    type: "payment_intent.canceled",
    data: { object: { id: "pi_synthetic", status: "canceled", metadata: { payment_id: "pay_synthetic" } } },
  });
  const digest = createHmac("sha256", targetKey).update(`${timestamp}.${rawBody}`).digest("hex");
  return { rawBody, signatureHeader: `t=${timestamp},v1=${digest}` };
}

describe("production Stripe webhook endpoint verification workflow", () => {
  it("exposes only the fixed verify-only production command", () => {
    expect(workflow).toContain("workflow_dispatch: {}");
    expect(workflow).not.toMatch(/^\s+inputs:/m);
    expect(workflow).not.toContain("${{ inputs.");
    expect(workflow).not.toContain("${{ github.event.inputs.");
    expect(workflow).toContain("run: pnpm run ops stripe:webhook-endpoint -- verify --environment production");
    expect(workflow).not.toContain("repoint-staging");
  });

  it("refuses to expose the production secret to code from another ref", () => {
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toMatch(/actions\/checkout@[^\n]+\n\s+with:\n\s+ref: refs\/heads\/main/);
  });

  it("uses only the production environment secret with read-only repository permissions", () => {
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}");
    expect(workflow).toMatch(/permissions:\n  contents: read/);
  });
});

describe("production Stripe webhook endpoint creation workflow", () => {
  it("registers only the current and prior signing keys and the capture at the protected creation step", () => {
    const authority = JSON.parse(
      readFileSync(resolve(".github/authority/platform-production-stripe-webhook-endpoint-create/create.json"), "utf8"),
    );
    expect(authority.grants.filter(({ purpose }) => purpose === "credential-rotation")).toEqual([
      {
        file: ".github/workflows/platform-production-stripe-webhook-endpoint-create.yml",
        jobId: "create",
        stepAnchor: "name:Create and verify production Stripe webhook endpoint#3",
        secretName: "STRIPE_WEBHOOK_SECRET",
        purpose: "credential-rotation",
      },
      {
        file: ".github/workflows/platform-production-stripe-webhook-endpoint-create.yml",
        jobId: "create",
        stepAnchor: "name:Create and verify production Stripe webhook endpoint#3",
        secretName: "STRIPE_WEBHOOK_SECRET_PREVIOUS",
        purpose: "credential-rotation",
      },
      {
        file: ".github/workflows/platform-production-stripe-webhook-endpoint-create.yml",
        jobId: "create",
        stepAnchor: "name:Create and verify production Stripe webhook endpoint#3",
        secretName: captureName,
        purpose: "credential-rotation",
      },
    ]);
  });
  it("requires the exact production confirmation and remains main-only", () => {
    expect(createWorkflow).toContain("workflow_dispatch:");
    expect(createWorkflow).toContain("confirmation:");
    expect(createWorkflow).toContain("required: true");
    expect(createWorkflow).toContain("inputs.confirmation == 'create production payments webhook endpoint'");
    expect(createWorkflow).toContain("github.ref == 'refs/heads/main'");
    expect(createWorkflow).toMatch(/actions\/checkout@[^\n]+\n\s+with:\n\s+ref: refs\/heads\/main/);
    expect(createWorkflow).toContain('--confirm "$CONFIRMATION"');
  });

  it("uses a protected production environment, unique concurrency, and minimal permissions", () => {
    expect(createWorkflow).toContain("environment: production");
    expect(createWorkflow).toContain("group: platform-production-stripe-webhook-endpoint-create");
    expect(createWorkflow).toMatch(/permissions:\n  contents: read/);
    expect(createWorkflow).not.toMatch(/^\s{2}(?:actions|checks|deployments|issues|pull-requests): write$/m);
  });

  it("keeps credentials step-scoped and pipes the signing secret only to the production GitHub secret", () => {
    expect(createWorkflow).toContain("STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}");
    expect(createWorkflow).toContain("GH_TOKEN: ${{ secrets.ENVIRONMENT_SECRETS_TOKEN }}");
    expect(createWorkflow).not.toContain("GH_TOKEN: ${{ github.token }}");
    expect(createWorkflow).toContain('pnpm run ops stripe:webhook-endpoint -- "${args[@]}"');
    expect(createWorkflow).toContain("- create-canonical");
    expect(createWorkflow).toContain("- replace-version");
    expect(createWorkflow).toContain(' --phase "$PHASE"');
    expect(createWorkflow).toContain("STRIPE_WEBHOOK_SECRET_PREVIOUS: ${{ secrets.STRIPE_WEBHOOK_SECRET_PREVIOUS }}");
  });

  it("uses only a step-scoped capture, bounds bytes, and removes the runner file on failure", () => {
    const workflow = parse(createWorkflow);
    expect(workflow.on.workflow_dispatch.inputs.use_signed_delivery_capture).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(workflow.jobs.create.env).toBeUndefined();
    expect(createStep.env[captureName]).toContain(
      `inputs.operation == 'replace-version' && inputs.phase == 'complete' && inputs.use_signed_delivery_capture && secrets.${captureName}`,
    );
    const directory = mkdtempSync(join(tmpdir(), "stripe-delivery-workflow-"));
    try {
      const optedIn = { USE_SIGNED_DELIVERY_CAPTURE: "true" };
      for (const value of ["", "\u00e9".repeat(24577)]) {
        const rejected = runCompletionShell(directory, { ...optedIn, [captureName]: value });
        expect(rejected.status, rejected.error?.message ?? rejected.stderr).toBe(1);
        expect(rejected.stderr).toContain("1 to 49152 bytes");
        expect(rejected.stdout).toBe("");
      }
      const prepare = runCompletionShell(directory, { ...optedIn, PHASE: "prepare" });
      expect(prepare.status, prepare.error?.message ?? prepare.stderr).toBe(1);
      expect(prepare.stderr).toContain("only allowed for replace-version completion");
      const failed = runCompletionShell(directory, {
        ...optedIn,
        [captureName]: JSON.stringify(signedEndiveDelivery()),
        SYNTHETIC_EXIT: "9",
      });
      expect(failed.status, failed.error?.message ?? failed.stderr).toBe(9);
      expect(existsSync(failed.stdout.split("\0").at(-2))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the protected signed file when Event GET is Dahlia and retires only after the real inbox duplicate response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stripe-delivery-workflow-"));
    try {
      const capture = signedEndiveDelivery();
      const event = JSON.parse(capture.rawBody);
      const env = {
        STRIPE_SECRET_KEY: "sk_live_synthetic_fixture",
        STRIPE_WEBHOOK_SECRET: targetKey,
        STRIPE_WEBHOOK_SECRET_PREVIOUS: oldKey,
      };
      const gateway = createStripePaymentProcessorGateway({
        secretKey: env.STRIPE_SECRET_KEY,
        publishableKey: "pk_live_synthetic_fixture",
        webhookSecret: targetKey,
      });
      const inboxIds = new Set();
      const inboxAttempts = [];
      let domainWrites = 0;
      const runWebhook = createPaymentWebhookRunner(
        {
          connect: async () => ({
            release() {},
            async query(sql, [id] = []) {
              if (!sql.includes("INSERT INTO payments_provider_webhook_events")) return { rows: [] };
              expect(sql).toContain("ON CONFLICT (provider_event_id) DO NOTHING");
              inboxAttempts.push(id);
              if (inboxIds.has(id)) return { rows: [] };
              inboxIds.add(id);
              return { rows: [{ provider_event_id: id }] };
            },
          }),
        },
        {},
      );
      const verifier = createPaymentProcessorWebhookRoutes({
        async processWebhook(input) {
          const parsed = await gateway.parseWebhook(input);
          return (
            await runWebhook(
              {
                tableName: "payments_provider_webhook_events",
                providerEventId: parsed.eventId,
                providerName: parsed.processorName,
                eventKind: parsed.kind,
              },
              async () => {
                domainWrites++;
                return { received: true, ignored: false };
              },
            )
          ).result;
        },
      });
      const route = (body, signature) =>
        verifier.request("/webhooks", {
          method: "POST",
          body,
          headers: { "Stripe-Signature": signature },
        });
      const badSignature = await route(
        capture.rawBody,
        capture.signatureHeader.replace(/v1=.*/, `v1=${"0".repeat(64)}`),
      );
      expect(badSignature.ok).toBe(false);
      expect(inboxAttempts).toEqual([]);
      const first = await route(capture.rawBody, capture.signatureHeader);
      expect(await first.json()).toEqual({ received: true, ignored: false });

      const endpoint = {
        url: canonicalUrl,
        livemode: true,
        status: "enabled",
        enabled_events: STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS,
      };
      const old = { ...endpoint, id: "we_synthetic_old", api_version: "2026-03-25.dahlia" };
      const target = {
        ...endpoint,
        id: "we_synthetic_target",
        api_version: registry.apiVersion,
        metadata: {
          replacement_for: old.id,
          signing_handoff: "ready",
          signing_key_digest: createHash("sha256").update(targetKey).digest("hex"),
        },
      };
      let endpoints = [old, target];
      const calls = [];
      const dependencies = {
        fetch: async (url, init) => {
          if (url === canonicalUrl) {
            calls.push("replay");
            const reply = await route(init.body, init.headers["Stripe-Signature"]);
            expect(await reply.clone().json()).toEqual({
              received: true,
              ignored: true,
              failure_class: "inbox-conflict",
            });
            return reply;
          }
          const path = new URL(url).pathname;
          if (path === "/v1/webhook_endpoints") return Response.json({ data: endpoints, has_more: false });
          if (path === `/v1/events/${eventId}`) {
            calls.push("event-get");
            return Response.json({ ...event, api_version: old.api_version });
          }
          if (path === `/v1/webhook_endpoints/${old.id}` && init.method === "DELETE") {
            calls.push("retire-old");
            endpoints = [target];
            return Response.json({ deleted: true });
          }
          throw new Error("Unexpected synthetic request");
        },
      };
      const idOnly = runCompletionShell(directory);
      expect(idOnly.status, idOnly.error?.message ?? idOnly.stderr).toBe(0);
      const commandArgs = (result) => result.stdout.split("\0").slice(4, -1);
      expect(commandArgs(idOnly)).not.toContain("--delivery-file");
      await expect(runStripePaymentsWebhookEndpointCommand(commandArgs(idOnly), env, dependencies)).rejects.toThrow(
        "target API version",
      );
      expect(calls).toEqual(["event-get"]);
      expect(endpoints).toEqual([old, target]);

      const withCapture = runCompletionShell(directory, {
        USE_SIGNED_DELIVERY_CAPTURE: "true",
        [captureName]: JSON.stringify(capture),
      });
      expect(withCapture.status, withCapture.error?.message ?? withCapture.stderr).toBe(0);
      const args = commandArgs(withCapture);
      expect(args.at(-2)).toBe("--delivery-file");
      expect(existsSync(args.at(-1))).toBe(false);
      // Use the captured bytes copied at the pnpm boundary before normal runner cleanup.
      args[args.length - 1] = join(directory, "synthetic-proof.json");
      await expect(runStripePaymentsWebhookEndpointCommand(args, env, dependencies)).resolves.toMatchObject({
        retiredEndpointId: old.id,
        verification: { ok: true },
      });
      expect(calls).toEqual(["event-get", "replay", "retire-old"]);
      expect(endpoints).toEqual([target]);
      expect([...inboxIds]).toEqual([eventId]);
      expect(inboxAttempts).toEqual([eventId, eventId]);
      expect(domainWrites).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
