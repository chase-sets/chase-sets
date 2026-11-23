# [corten-run/corten#1488 Stripe.js's Payment Element throws an uncaught TypeError on every mount under the default policy <Corten /> makes: it parses an SVG string with DOMParser, and the policy passes only script URLs](https://github.com/corten-run/corten/issues/1488)

Closed, still cited as the change the pilot relies on or the decision that left part of the workaround to the app.

What the pilot does now: closed as an app concern. The Stripe payment areas allow `trusted_types_policy("default")` and make the policy in [marketplace/src/views/stripe.js](../../marketplace/src/views/stripe.js): Corten's script-URL rule, plus Stripe's loader SVG filter, compared whole, at `DOMParser parseFromString` only. When Stripe changes that filter, the mount logs its TypeError again until the string is updated. Payout setup keeps `<Corten />`'s policy
