import { describe, expect, it } from "vitest";
import type { ReleaseTrain } from "@stripe/stripe-js";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";

// @stripe/stripe-js pins each published version to a single Stripe.js release
// channel (https://js.stripe.com/<channel>/stripe.js). The server pins its
// Stripe-Version header to STRIPE_API_VERSION
// (infrastructure/stripe-config/webhook-events.json apiVersion). The two must
// name the same channel or the buyer-facing embed and the server's API calls
// drift onto different Stripe.js releases.
//
// `ReleaseTrain` is a literal type ("dahlia" for the currently installed
// @stripe/stripe-js version). Assigning it below fails to typecheck the
// moment a future @stripe/stripe-js upgrade moves to a different channel,
// forcing a deliberate re-verification instead of a silent drift.
const installedReleaseChannel: ReleaseTrain = "dahlia";

describe("stripe typed loader release channel", () => {
  it("keeps @stripe/stripe-js aligned with the server's pinned Stripe API version", () => {
    expect(STRIPE_API_VERSION.endsWith(`.${installedReleaseChannel}`)).toBe(true);
  });
});
