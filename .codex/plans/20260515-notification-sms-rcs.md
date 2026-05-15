# SMS/RCS Notification Integration

## Intent

Recommend the most effective and cost-efficient way to add SMS/RCS interactions to the existing Notifications system.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-notification-sms-rcs`
- Branch: `codex/notification-sms-rcs`
- Sandbox id: not generated; no dependency setup or dev/test command needed for recommendation-only work.
- Dependency setup: not run.
- Setup blockers: none for planning/recommendation.

## Owning Contexts

- Notifications owns channel eligibility, consent, delivery policy, notification preferences, outbox dispatch, and delivery state.
- Infrastructure owns provider adapters and webhook normalization.
- Source contexts continue to publish facts only; they should not call SMS/RCS providers directly.

## Resolved Decisions

- Preferred first SMS/RCS provider: Twilio Programmable Messaging.
- Keep Amazon SES for email and web notifications for the in-app feed.
- Treat SMS/RCS as escalation channels for high-value or time-sensitive moments, not default delivery.
- Model SMS and RCS as first-class notification channels with required SMS fallback for RCS journeys, not as separate source-context workflows.
- Start with A2P 10DLC. Do not use short codes until throughput or deliverability data justifies the monthly cost.
- Use the existing Notifications context and `notification_outbox`; do not create a parallel communications subsystem.
- Keep Twilio request signing, API calls, and webhook normalization in `infrastructure/twilio-messaging`.
- Default the `sms` and `rcs` preferences to off until explicit consent and phone-number ownership are modeled.

## Open Questions

- Which first SMS/RCS use case should ship: account security, shipment exception, payout issue, or product alert conversion?
- Do we need two-way buyer/seller support workflows in phase one, or outbound notifications only?

## Implementation Checklist

- [x] Extend notification contracts with `sms` and `rcs` channels that can represent mobile-message preferences without exposing provider payloads.
- [x] Add a Twilio infrastructure adapter for Programmable Messaging.
- [x] Add Twilio status/inbound webhook ingestion through a Notifications-owned provider-event table and unauthenticated provider mount.
- [x] Keep SMS/RCS delivery opt-in disabled by default in notification preferences.
- [x] Add provider webhook signature verification tests.
- [x] Add notification outbox retry coverage for failed SMS sends.
- [ ] Add full consent, opt-out, quiet-hour, frequency-cap, and max-cost policy checks in Notifications before enabling any broad non-security send type.
- [ ] Add delivery outcome and failure classification read models for support and cost monitoring beyond raw provider-event storage.
- Add provider benchmark hooks so AWS End User Messaging and Telnyx can be evaluated after real traffic exists.

## Verification

- `pnpm --filter @chase-sets/notifications run test` passed.
- `pnpm --filter @chase-sets/notification-outbox run test` passed.
- `pnpm --filter @chase-sets/twilio-messaging run test` passed.
- `pnpm --filter @chase-sets/notification-center run test` passed.
- `pnpm --filter @chase-sets/app-platform-api run test -- __tests__/config.test.ts __tests__/app.test.ts` passed.
- `pnpm --filter @chase-sets/app-platform-worker run test -- __tests__/config.test.ts` passed.
- `pnpm run check:no-any` passed.
- `pnpm run test:structure` passed.
- `pnpm run check:structure` passed.
- `pnpm run typecheck` passed.
- `pnpm run verify:metadata` passed.
- `pnpm run verify:static` passed.
- `pnpm run test:fast` passed.
- `pnpm run build` passed.

## Documentation To Promote

- Update `docs/architecture/notifications-channel-and-provider-recommendation.md` after choosing the first production SMS/RCS use case.
- Consider an ADR only if we commit to Twilio as a hard-to-reverse production vendor choice.

## Goal Completion Criteria

- Future implementation goal should cover implementation in this worktree, durable doc promotion, automated tests, webhook and retry verification, mobile/desktop notification UI checks where affected, PR submission, passing CI, PR merge, staging deploy verification, and retaining this plan.
