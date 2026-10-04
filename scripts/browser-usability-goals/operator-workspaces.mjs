export default {
  id: "operator-workspaces",
  routeScope: [
    "^bounded-contexts/(?!catalog/)[^/]+/routes/(admin|access-admin)/",
    "^deployables/admin-web/app/routes/(?!catalog-)",
  ],
  goals: [
    {
      id: "operator-sign-in",
      version: 1,
      startPath: "/access/sign-in",
      role: "operator",
      host: "admin-web",
      startSignedIn: false,
      goal: "You work for Chase Sets and want to sign in to the staff console with the work email address in your task context, using your password. Get as far as the screen where you would type that password, then stop. Do not type or submit a password, ask for a magic link or a phone code, or use a passkey.",
      checks: ["password-step", "no-credential-submitted"],
      oracle: {
        "password-step":
          "Final screenshot shows the password entry step for the task-context email with the submit control not activated; compare the action log against the recorder's click and typeText entries.",
        "no-credential-submitted":
          "Auth sessions read model and the notifications outbox show no new session, magic link, or phone code for the task-context email after the run.",
      },
      routes: {
        "bounded-contexts/auth/routes/access-admin/sign-in.tsx": "password-step",
      },
      paths: ["bounded-contexts/auth/features/sign-in/", "bounded-contexts/auth/routes/access-admin/"],
    },
    {
      id: "operator-sign-out",
      version: 1,
      startPath: "/",
      role: "operator",
      host: "admin-web",
      startSignedIn: true,
      goal: "You are finished for the day. Sign out of the staff console and make sure you are no longer signed in.",
      checks: ["signed-out", "session-restored"],
      oracle: {
        "signed-out":
          "Clean-route revisit of a protected staff page requires sign-in, and the auth sessions read model shows the moderator's starting session ended. The final screenshot alone is not evidence.",
        "session-restored":
          "The moderator signs the same synthetic operator back in and restores the starting authenticated state.",
      },
      routes: {
        "bounded-contexts/auth/routes/access-admin/sign-out.tsx": "signed-out",
      },
      paths: ["bounded-contexts/auth/support/route-support/", "deployables/admin-web/app/admin-account-menu"],
      permits: "You may sign out of the session the moderator signed in for you.",
    },
    {
      id: "operator-session-review",
      version: 1,
      startPath: "/access",
      role: "operator",
      host: "admin-web",
      goal: "A teammate named in your task context thinks an old device may still be signed in. Find that teammate's sign-in sessions, and for the most recent one report how it was authenticated, which account it is acting for, and when it expires. Do not revoke a session or switch its account.",
      checks: ["session-method", "session-expiry", "no-session-changed"],
      oracle: {
        "session-method":
          "Compare the reported authentication method and account against the auth seed session for the task-context user (seededAuthSessions) and the live sessions read model.",
        "session-expiry":
          "Compare the reported expiry against the session detail read model; the list does not show it.",
        "no-session-changed":
          "Sessions read model shows no revoke or account-switch for any session during the run window.",
      },
      routes: {
        "bounded-contexts/auth/routes/access-admin/sessions.tsx": "session-method",
        "bounded-contexts/auth/routes/access-admin/sessions-detail.tsx": "session-expiry",
      },
      paths: ["bounded-contexts/auth/features/sessions/", "deployables/admin-web/app/"],
    },
    {
      id: "operator-account-access-review",
      version: 1,
      startPath: "/access",
      role: "operator",
      host: "admin-web",
      goal: "You are doing a quarterly access review. Find out which accounts are currently suspended and whether the person who owns one of them can still sign in. Then, for the Demo Account, find who holds the owner role, whether the support teammate's access is currently active, and what has happened to that teammate's access over time. Do not suspend, reactivate, invite, change a role, or revoke anything.",
      checks: ["suspended-accounts", "owner-user-status", "team-roles", "membership-history", "no-access-changed"],
      oracle: {
        "suspended-accounts":
          "Compare against the identity seed: acc_seed_suspended_account (Dormant Account) is the only suspended account; confirm in the accounts read model.",
        "owner-user-status":
          "A screenshot or the action log shows the users list with its status column; the account hub's per-user suspend or reactivate control alone is not evidence. Compare against the identity seed: the Dormant Account owner (usr_seed_suspended_user) is suspended; confirm in the users read model.",
        "team-roles":
          "Compare against the identity seed memberships for acc_seed_demo_account: demo owner, support teammate manager; confirm in the memberships read model.",
        "membership-history":
          "Compare against the identity seed: the support membership was granted as viewer, changed to manager, revoked, then reinstated; confirm in the account hub audit read model.",
        "no-access-changed":
          "Identity read models and the account audit timeline show no new membership, invitation, suspension, or role events during the run window.",
      },
      routes: {
        "bounded-contexts/identity/routes/admin/access-home.tsx": "suspended-accounts",
        "deployables/admin-web/app/routes/access-home.tsx": "suspended-accounts",
        "bounded-contexts/identity/routes/admin/users.tsx": "owner-user-status",
        "bounded-contexts/identity/routes/admin/accounts-detail.tsx": "membership-history",
      },
      paths: [
        "bounded-contexts/identity/features/access-hub/",
        "bounded-contexts/identity/features/accounts/",
        "bounded-contexts/identity/features/users/",
        "bounded-contexts/identity/features/memberships/",
        "deployables/admin-web/app/",
      ],
    },
    {
      id: "operator-integration-access-review",
      version: 1,
      startPath: "/access",
      role: "operator",
      host: "admin-web",
      goal: "The Demo Account says an automation stopped working and a teammate never joined. Find out which of that account's API keys can still be used and which one was revoked, and what became of each invitation that was sent for the account. Do not create, rotate, revoke, resend, cancel, or decline anything.",
      checks: ["api-key-states", "invitation-outcomes", "no-credentials-changed"],
      oracle: {
        "api-key-states":
          "Compare against the identity seed: key_seed_demo_primary active, key_seed_rotated_revoked revoked; confirm in the API keys read model.",
        "invitation-outcomes":
          "Compare against the identity seed: four Demo Account invitations ending accepted, declined, cancelled, and expired; confirm in the invitations read model.",
        "no-credentials-changed":
          "API key and invitation read models show no new, rotated, revoked, resent, or cancelled records, and no one-time secret panel appears in any screenshot.",
      },
      routes: {
        "bounded-contexts/identity/routes/admin/accounts-detail.tsx": "api-key-states",
      },
      paths: ["bounded-contexts/identity/features/api-keys/", "bounded-contexts/identity/features/invitations/"],
    },
    {
      id: "operator-platform-access-audit",
      version: 1,
      startPath: "/access",
      role: "operator",
      host: "admin-web",
      goal: "Security wants a platform-wide access audit rather than a single account's. Across every account on the platform, find each account whose legal name differs from the name shoppers see, and give both names. Find everyone who holds a role other than owner, which account they are on, and whether that access is active. Find every invitation that was never accepted and what happened to it instead. Finally, find every API key that has been revoked and whose key it was. Do not suspend, reactivate, change a role, revoke, invite, create, rotate, resend, cancel, or decline anything.",
      checks: [
        "legal-name-mismatches",
        "non-owner-roles",
        "unaccepted-invitations",
        "revoked-keys",
        "no-record-changed",
      ],
      oracle: {
        "legal-name-mismatches":
          "A screenshot or the action log shows the accounts list, the only page with a legal name column across accounts; the access home table shows display names only and the account hub one account. Compare against the identity seed: Demo Account/Chase Sets, Demo Collector/Collector Zero, Value Trader/Binder Builder, High Roller Trader/Top Loader Capital, and Sealed Stockroom/Pack Runners differ; Support Ops, Dormant Account, and the platform admin bootstrap account (Chase Sets Platform, when bootstrapped) match; confirm in the accounts read model.",
        "non-owner-roles":
          "A screenshot or the action log shows the memberships list, the only page with roles across accounts; the access home lists only memberships pending review. Compare against the identity seed: mbr_seed_support_membership is Support User as manager on Demo Account, active; every other seeded membership is owner; the platform admin bootstrap (bootstrapPlatformAdminIdentity), when run, adds one platform-admin membership on Chase Sets Platform; confirm in the memberships read model.",
        "unaccepted-invitations":
          "A screenshot or the action log shows the invitations list across accounts; the access home lists only pending invitations and the account hub only one account's. Compare against the identity seed: ivt_seed_declined, ivt_seed_cancelled, and ivt_seed_expired (viewer invitations on Demo Account) ended declined, cancelled, and expired; ivt_seed_support_accept was accepted; none is pending; confirm in the invitations read model.",
        "revoked-keys":
          "A screenshot or the action log shows the API keys list across accounts; the access home lists only active keys due for rotation and the account hub only one account's. Compare against the identity seed: key_seed_rotated_revoked (Legacy automation key, Demo Account user) is the only revoked key and key_seed_demo_primary stays active; confirm in the API keys read model.",
        "no-record-changed":
          "Identity read models show no new or changed account, membership, invitation, or API key during the run window, and no one-time secret panel appears in any screenshot.",
      },
      routes: {
        "bounded-contexts/identity/routes/admin/accounts.tsx": "legal-name-mismatches",
        "bounded-contexts/identity/routes/admin/memberships.tsx": "non-owner-roles",
        "bounded-contexts/identity/routes/admin/invitations.tsx": "unaccepted-invitations",
        "bounded-contexts/identity/routes/admin/api-keys.tsx": "revoked-keys",
      },
      paths: [
        "bounded-contexts/identity/features/accounts/",
        "bounded-contexts/identity/features/memberships/",
        "bounded-contexts/identity/features/invitations/",
        "bounded-contexts/identity/features/api-keys/",
      ],
    },
    {
      id: "operator-fee-terms-lookup",
      version: 1,
      startPath: "/commerce",
      role: "operator",
      host: "admin-web",
      goal: "A seller on the Demo Account asks what fee they pay when something sells, compared with what every other seller pays. Find the standard marketplace sales fee and the Demo Account's own agreed fee, including the percentage, any fixed amount or cap, and the date each took effect. Do not create or revise any terms.",
      checks: ["standard-fee", "account-fee", "no-terms-changed"],
      oracle: {
        "standard-fee":
          "Compare against the commercial-terms seed schedule (seedMarketplaceSalesFeeScheduleIfMissing: 500 bps, no fixed amount, $25.00 cap, effective 2026-07-03) and the schedules read model.",
        "account-fee":
          "Compare against the commercial-terms seed agreement cag_seed_seller_override (700 bps plus $0.05, effective 2026-01-01) and the agreements read model.",
        "no-terms-changed": "Schedule and agreement read models show no new revision during the run window.",
      },
      routes: {
        "bounded-contexts/commercial-terms/routes/admin/home.tsx": "standard-fee",
      },
      paths: ["bounded-contexts/commercial-terms/features/"],
    },
    {
      id: "operator-postage-rules-lookup",
      version: 1,
      startPath: "/commerce",
      role: "operator",
      host: "admin-web",
      goal: "A seller asks which postage rules apply to orders placed today. Find the postage policy currently in effect, when it became active, and whether any replacement is drafted or waiting to be activated. Do not create, activate, retire, clone, or revise a policy.",
      checks: ["active-policy", "pending-replacements", "no-policy-changed"],
      oracle: {
        "active-policy":
          "Compare against the ordering seed opp_seed_default (Default postage policy, activated) and the postage policy read model.",
        "pending-replacements": "Postage policy read model shows no drafts; the seed creates none.",
        "no-policy-changed":
          "Postage policy read model shows no new draft, activation, or retirement during the run window.",
      },
      routes: {
        "bounded-contexts/ordering/routes/admin/postage-policies.tsx": "active-policy",
      },
      paths: ["bounded-contexts/ordering/features/postage-policies/"],
    },
    {
      id: "operator-wallet-review",
      version: 1,
      startPath: "/access",
      role: "operator",
      host: "admin-web",
      goal: "The Demo Account's owner asks why their available balance includes money that did not come from a sale. Find the account's current available and pending balances, and the description recorded for the credit that was not a sale. Do not request, approve, reject, or reverse any balance change.",
      checks: ["balances", "credit-description", "no-adjustment-submitted"],
      oracle: {
        balances: "Compare against the settlement wallet read model for acc_seed_demo_account at run time.",
        "credit-description":
          "Compare against the settlement seed ledger entry led_seed_available_adjustment_credit ($30.00 credit, kind adjustment, description 'Manual credit adjustment for seeded balance coverage') and the wallet ledger read model.",
        "no-adjustment-submitted":
          "Wallet adjustment history and ledger read models for acc_seed_demo_account show no new request or entry during the run window.",
      },
      routes: {
        "bounded-contexts/settlement/routes/admin/wallet-workbench.tsx": "balances",
      },
      paths: ["bounded-contexts/settlement/features/wallets/"],
    },
    {
      id: "operator-payout-health-review",
      version: 1,
      startPath: "/commerce",
      role: "operator",
      host: "admin-web",
      goal: "Finance asks for a quick money check. Find how many seller payouts have failed, the amount of each, and whether any of them is queued to retry. Then find whether any account currently owes the platform money. Do not run a reconciliation or retry anything.",
      checks: ["failed-payouts", "negative-balances", "no-reconciliation-run"],
      oracle: {
        "failed-payouts":
          "Compare against the settlement seed payouts pyo_seed_failed ($20.00) and pyo_seed_synthetic_fee_failed ($5.00), both failed, and the payout read model's retry state.",
        "negative-balances": "Money health read model: the seed creates no negative wallet balances.",
        "no-reconciliation-run": "Reconciliation run read model shows no new run started during the run window.",
      },
      routes: {
        "bounded-contexts/settlement/routes/admin/payout-operations.tsx": "failed-payouts",
        "bounded-contexts/settlement/routes/admin/money-health.tsx": "negative-balances",
      },
      paths: [
        "bounded-contexts/settlement/features/payouts/",
        "bounded-contexts/settlement/features/payout-readiness/",
      ],
    },
    {
      id: "operator-promo-bar-review",
      version: 1,
      startPath: "/growth",
      role: "operator",
      host: "admin-web",
      goal: "Marketing asks what shoppers currently see in the announcement strip at the top of the public marketplace. Find every announcement that is live right now, which one shows first, and where each one links. Do not create, edit, reorder, activate, deactivate, or delete an announcement.",
      checks: ["live-messages", "no-banner-changed"],
      oracle: {
        "live-messages":
          "Compare against the public-presence seed (seedPublicPresencePromoBarMessages): two active messages, shipping credit first at order 10, beta listing fees at order 20, with their link labels; confirm in the promo bar read model.",
        "no-banner-changed": "Promo bar read model shows the same two messages, order, and active flags after the run.",
      },
      routes: {
        "bounded-contexts/public-presence/routes/admin/promo-bar.tsx": "live-messages",
      },
      paths: ["bounded-contexts/public-presence/features/promo-bar/"],
    },
    {
      id: "operator-google-shopping-review",
      version: 1,
      startPath: "/growth",
      role: "operator",
      host: "admin-web",
      goal: "A seller asks whether any listings are being kept out of Google Shopping. Find how many feed rows are currently failing or disapproved, and whether updates to Google are being sent live right now or held back. Do not start a sync, maintenance, or diagnostics run, even as a dry run.",
      checks: ["failing-rows", "live-gate", "no-job-enqueued"],
      oracle: {
        "failing-rows":
          "Compare against the discovery feed-row read model filtered to failed and disapproved at run time; the catalog seed produces no failing rows.",
        "live-gate":
          "Live writes are gated on this page by the launch gate (#3032); compare the reported state against that gate.",
        "no-job-enqueued":
          "Google Shopping sync job read model shows no new full sync, maintenance, or diagnostics job during the run window.",
      },
      routes: {
        "bounded-contexts/discovery/routes/admin/google-shopping.tsx": "failing-rows",
      },
      paths: ["bounded-contexts/discovery/features/google-shopping-operations/"],
    },
    {
      id: "operator-marketplace-insights",
      version: 1,
      startPath: "/",
      role: "operator",
      host: "admin-web",
      goal: "Leadership wants a quick read on how the marketplace is doing. Starting from the staff console home, find the total sales value and the number of trades over the last 30 days. Then find how much fee revenue the platform is estimated to have given up for sellers whose fees are locked at zero.",
      checks: ["console-home-entry", "gmv-and-trades", "foregone-fees"],
      oracle: {
        "console-home-entry":
          "First screenshot shows the staff console sections home and the action log shows the Platform section opened from it, not reached directly.",
        "gmv-and-trades":
          "A screenshot or the action log shows the Ops Dashboard with its default 30-day range; Offer Economics also shows platform GMV and trades, but over its own 60-day default. Compare against the ops insights summary read model for the 30-day range at run time.",
        "foregone-fees":
          "Compare against the offer economics summary read model for the default reporting window at run time.",
      },
      routes: {
        "deployables/admin-web/app/routes/index.tsx": "console-home-entry",
        "bounded-contexts/platform-operations/routes/admin/ops-dashboard.tsx": "gmv-and-trades",
        "bounded-contexts/platform-operations/routes/admin/offer-economics.tsx": "foregone-fees",
      },
      paths: [
        "bounded-contexts/platform-operations/features/insights-dashboards/",
        "bounded-contexts/platform-operations/features/offer-economics/",
        "deployables/admin-web/app/routes/index",
      ],
    },
    {
      id: "operator-platform-health-check",
      version: 1,
      startPath: "/platform",
      role: "operator",
      host: "admin-web",
      goal: "You are on platform duty this morning. Find out whether anything is waiting for an operator and what the most severe item is. Find whether every data projection is healthy and which projection, if any, is furthest behind its source. Then find whether every connected provider has usable credentials configured. Do not retry, rebuild, cancel, or refresh anything.",
      checks: ["attention-queue", "projection-health", "projection-lag", "provider-readiness", "no-operation-queued"],
      oracle: {
        "attention-queue":
          "Compare against the operations attention read model at run time; seeded sources are the open support requests and the four unreviewed platform feedback entries.",
        "projection-health":
          "Compare against the projection operations snapshot (status and attention counts) at run time.",
        "projection-lag":
          "Compare against the per-projection source lag in the projection reference read model at run time.",
        "provider-readiness":
          "Compare against the provider connections read model: catalog provider readiness from the catalog integration bootstrap and the seeded tcgplayer manual connection (connection-seed-tcgplayer-manual).",
        "no-operation-queued":
          "Projection operation run read model shows no new retry, rebuild, cancel, or refresh during the run window.",
      },
      routes: {
        "bounded-contexts/platform-operations/routes/admin/operations-attention.tsx": "attention-queue",
        "bounded-contexts/platform-operations/routes/admin/projection-operations.tsx": "projection-health",
        "bounded-contexts/platform-operations/routes/admin/projection-operations-reference.tsx": "projection-lag",
        "bounded-contexts/platform-operations/routes/admin/provider-connections.tsx": "provider-readiness",
      },
      paths: [
        "bounded-contexts/platform-operations/features/operations-attention-queue/",
        "bounded-contexts/platform-operations/features/projection-operations/",
        "bounded-contexts/platform-operations/features/provider-connections/",
      ],
    },
    {
      id: "operator-policy-lookup",
      version: 1,
      startPath: "/platform",
      role: "operator",
      host: "admin-web",
      goal: "Compliance is checking which business rules are live. Find the rule that sets how many hours support has to review a damaged-product case, the exact value in effect, when it took effect, and whether any later revision is scheduled. Then find which version of the listing evidence rules is in effect and when it started. Do not revise, draft, validate, reject, or activate anything.",
      checks: ["support-review-hours", "scheduled-revisions", "listing-evidence-version", "no-policy-changed"],
      oracle: {
        "support-review-hours":
          "Compare against the platform-operations seed (seedSupportDeadlinePolicy: SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE for product-damaged, effective 2026-01-01) and the policy document read model.",
        "scheduled-revisions": "Policy document read model: the seed schedules no later revision.",
        "listing-evidence-version":
          "Compare against the marketplace seed (seedListingEvidencePolicy: LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, effective 2026-07-13) and the listing evidence policy read model.",
        "no-policy-changed":
          "Policy document and listing evidence policy read models show no new draft or revision during the run window.",
      },
      routes: {
        "bounded-contexts/platform-operations/routes/admin/policy-console.tsx": "support-review-hours",
        "bounded-contexts/platform-operations/routes/admin/policy-console-detail.tsx": "scheduled-revisions",
        "bounded-contexts/marketplace/routes/admin/listing-evidence-policy.tsx": "listing-evidence-version",
      },
      paths: [
        "bounded-contexts/platform-operations/features/policy-console/",
        "bounded-contexts/marketplace/features/listing-evidence-policy/",
      ],
    },
    {
      id: "operator-support-case-triage",
      version: 1,
      startPath: "/support",
      role: "operator",
      host: "admin-web",
      goal: "A buyer emails saying their damaged-card case was closed but they are unsure what was decided. Using the case reference in your task context, find that case, its current status, and the refund amount and responsibility recorded when it was resolved. Then find how many cases are still open and which one is due soonest. Do not add a note, respond, escalate, resolve, cancel, or close anything.",
      checks: ["case-lookup", "resolution-details", "open-queue", "no-case-changed"],
      oracle: {
        "case-lookup":
          "The task-context reference resolves to sup_seed_resolved_partial_refund in the support reference lookup read model.",
        "resolution-details":
          "Compare against the platform-operations seed (seededSupportRequestInventory: product-damaged, resolved, $5.00 partial refund, carrier responsibility) and the support request read model.",
        "open-queue":
          "Compare against the support operations queue read model: the seed leaves sup_seed_active_product_not_received and sup_seed_self_service_product_damaged open; deadlines come from the read model at run time.",
        "no-case-changed":
          "Support request audit read model shows no new note, response, escalation, or status change during the run window.",
      },
      routes: {
        "bounded-contexts/platform-operations/routes/admin/reference-lookup.tsx": "case-lookup",
        "bounded-contexts/platform-operations/routes/admin/requests.tsx": "open-queue",
      },
      paths: [
        "bounded-contexts/platform-operations/features/support-requests/",
        "bounded-contexts/platform-operations/features/support-reference-lookup/",
      ],
    },
    {
      id: "operator-platform-feedback-review",
      version: 1,
      startPath: "/support",
      role: "operator",
      host: "admin-web",
      goal: "The product team wants to know how people rated paying at checkout. Find the internal feedback about checkout, the rating and the exact comment left by the Demo Collector account, and the average rating across all feedback received. Do not mark anything reviewed, archive anything, or add a note.",
      checks: ["checkout-feedback", "average-rating", "no-feedback-changed"],
      oracle: {
        "checkout-feedback":
          "Compare against the platform-operations seed pfb_seed_checkout (collector, rating 5, comment 'Checkout totals were clear before payment.') and the platform feedback detail read model.",
        "average-rating":
          "Compare against the platform feedback metrics read model; the four seeded entries average 4.0.",
        "no-feedback-changed":
          "Platform feedback read model shows all seeded entries still new with no operator notes after the run.",
      },
      routes: {
        "bounded-contexts/platform-operations/routes/admin/platform-feedback.tsx": "average-rating",
        "bounded-contexts/platform-operations/routes/admin/platform-feedback-detail.tsx": "checkout-feedback",
      },
      paths: ["bounded-contexts/platform-operations/features/platform-feedback/"],
    },
  ],
  excludedRoutes: [
    { path: "deployables/admin-web/app/routes/access-layout.tsx", reason: "layout-only" },
    { path: "deployables/admin-web/app/routes/commerce-layout.tsx", reason: "layout-only" },
    { path: "deployables/admin-web/app/routes/growth-layout.tsx", reason: "layout-only" },
    { path: "deployables/admin-web/app/routes/platform-layout.tsx", reason: "layout-only" },
    { path: "deployables/admin-web/app/routes/support-layout.tsx", reason: "layout-only" },
    { path: "deployables/admin-web/app/routes/commerce-home.tsx", reason: "redirect-only" },
    { path: "deployables/admin-web/app/routes/growth-home.tsx", reason: "redirect-only" },
    { path: "deployables/admin-web/app/routes/platform-home.tsx", reason: "redirect-only" },
    { path: "deployables/admin-web/app/routes/support-home.tsx", reason: "redirect-only" },
    { path: "deployables/admin-web/app/routes/offline.tsx", reason: "error-page" },
    { path: "bounded-contexts/identity/routes/admin/users-detail.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/identity/routes/admin/memberships-detail.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/identity/routes/admin/invitations-detail.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/identity/routes/admin/api-keys-detail.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/commercial-terms/routes/admin/schedules.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/commercial-terms/routes/admin/schedules-detail.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/commercial-terms/routes/admin/agreements.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/commercial-terms/routes/admin/agreements-detail.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/commercial-terms/routes/admin/account-agreement-new.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/ordering/routes/admin/postage-policies-detail.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/platform-operations/routes/admin/request-detail.tsx", reason: "redirect-only" },
    {
      path: "bounded-contexts/auth/routes/access-admin/sign-in-magic.tsx",
      reason: "fixture-gap: no seeded magic-link token; the page renders only after an emailed link",
    },
    {
      path: "bounded-contexts/auth/routes/access-admin/account-select.tsx",
      reason: "fixture-gap: no seeded staff user holds more than one account membership",
    },
    {
      path: "bounded-contexts/customer-feedback/routes/admin/attention.tsx",
      reason: "fixture-gap: no seeded customer feedback cases; customer-feedback has no seeder",
    },
    {
      path: "bounded-contexts/fulfillment/routes/admin/return-intake.tsx",
      reason: "fixture-gap: no seeded return shipments or unidentified return packages",
    },
    {
      path: "bounded-contexts/inventory/routes/admin/recovered-items.tsx",
      reason: "fixture-gap: no seeded recovered inventory items",
    },
    {
      path: "bounded-contexts/platform-operations/routes/admin/csat-dashboard.tsx",
      reason: "fixture-gap: no seeded CSAT invitations or responses; customer-feedback has no seeder",
    },
    {
      path: "bounded-contexts/platform-operations/routes/admin/risk-alerts.tsx",
      reason: "fixture-gap: no seeded risk alerts, and no seeded role grants reported-content.view",
    },
    {
      path: "bounded-contexts/platform-operations/routes/admin/risk-alert-detail.tsx",
      reason: "fixture-gap: no seeded risk alerts, and no seeded role grants reported-content.view",
    },
    {
      path: "bounded-contexts/platform-operations/routes/admin/reported-content.tsx",
      reason: "fixture-gap: no seeded content reports, and no seeded role grants reported-content.view",
    },
    {
      path: "bounded-contexts/platform-operations/routes/admin/reported-content-detail.tsx",
      reason: "fixture-gap: no seeded content reports, and no seeded role grants reported-content.view",
    },
    {
      path: "bounded-contexts/public-presence/routes/admin/waitlist.tsx",
      reason: "fixture-gap: no seeded waitlist signups",
    },
    {
      path: "bounded-contexts/public-presence/routes/admin/campaign-analytics.tsx",
      reason: "fixture-gap: no seeded waitlist signups to attribute",
    },
  ],
};
