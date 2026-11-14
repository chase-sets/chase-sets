import { defineConfig } from "@playwright/test";
import sharedConfig from "./playwright.config";

// The dedicated retention-governance surface for the functional Stripe embed
// UAT. It imports the shared config -- heavy-slot admission,
// projects, and webServer inherited unchanged -- and overrides exactly the
// retention-bearing settings: the list reporter alone (no HTML report, no
// retry telemetry), the governed outputDir every durable byte lands under
// (`.last-run.json` and the explicitly written capture PNGs included),
// trace/screenshot/video off for passing and intentionally failing
// invocations alike, and zero retries.
//
// Consumed only through `--config` by the functional UAT, refusal, and
// provider-free battery invocations of
// deployables/marketplace/e2e/account-payment-stripe-embed.uat.spec.ts; no
// package script consumes it and the shared playwright.config.ts does not
// move. The in-spec guard refuses any configured invocation whose
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
