import { defineConfig } from "@playwright/test";
import sharedConfig from "./playwright.config";

// The dedicated retention-governance surface for the Stripe appearance
// acceptance probe. It imports the shared config -- heavy-slot admission,
// projects, and webServer inherited unchanged -- and overrides exactly the
// retention-bearing settings: the list reporter alone (no HTML report, no
// retry telemetry), the governed outputDir every durable byte lands under
// (`.last-run.json` and the explicitly written capture PNGs included),
// trace/screenshot/video off for passing and intentionally failing
// invocations alike, and zero retries.
//
// Consumed only through `--config` by the evidence, control, refusal, and
// provider-free battery invocations of
// deployables/marketplace/e2e/account-payment-stripe-embed.uat.spec.ts; no
// package script consumes it and the shared playwright.config.ts does not
// move. The probe spec digest-binds this file's bytes into every acceptance
// receipt, so any later edit here mechanically stales the receipt, and its
// in-spec guard refuses any configured or control-mode invocation whose
// resolved settings do not match this surface.
export default defineConfig(sharedConfig, {
  reporter: [["list"]],
  outputDir: "artifacts/stripe-appearance-evidence/test-results",
  retries: 0,
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
