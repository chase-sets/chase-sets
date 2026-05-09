# Email Delivery Completion Task List

This checklist tracks closure of the seven implementation findings.

- [x] 1. Wire transactional email into real bounded-context event flows.
- [x] 2. Add template renderer abstraction with locale/template version support and text + HTML content.
- [x] 3. Add provider error normalization and retry behavior for transient failures.
- [x] 4. Add observability hooks for attempt/result telemetry.
- [x] 5. Add inbound SES notification parsing for bounce/complaint/delivery.
- [x] 6. Tighten contract semantics (criticality, typed message format, structured recipients, template version).
- [x] 7. Add broader tests, including retry/error and webhook parsing behavior.


## Current wired intents

- `auth.magic-link.requested`
- `ordering.order.created`
- `fulfillment.shipment.delivered`
- `settlement.payout.completed`


## Event-triggered wiring status

Each wired intent now has a registered runtime projector that triggers gateway sends from canonical event payloads (no inline send calls in route/runtime handlers).
