export default {
  id: "seller",
  routeScope: [
    "^bounded-contexts/checkout/routes/(account-desk-offers|account-sell-list|sell-checkout-session|sell-checkout-confirmation)\\.tsx$",
    "^bounded-contexts/marketplace/routes/(account-desk|account-listing|account-listings|account-listings-new)\\.tsx$",
    "^bounded-contexts/marketplace/routes/marketplace/(account-received-reviews|account-sale-review)\\.tsx$",
    "^bounded-contexts/ordering/routes/account-sales?\\.tsx$",
    "^bounded-contexts/fulfillment/routes/marketplace/account-sale-",
    "^bounded-contexts/inventory/routes/marketplace/",
    "^bounded-contexts/pricing/routes/marketplace/(account-desk-repricing|account-desk-repricing-policy|account-repricing|bulk-reprice)\\.tsx$",
    "^bounded-contexts/settlement/routes/marketplace/",
    "^bounded-contexts/channels/routes/marketplace/",
    "^bounded-contexts/identity/routes/marketplace/account-team\\.tsx$",
  ],
  goals: [
    {
      id: "seller-away",
      version: 1,
      startPath: "/account",
      role: "seller",
      host: "marketplace",
      goal: "Schedule time away for the future dates supplied in your fixture task context, with automatic return. Then leave that area and come back to confirm the schedule. Change only this synthetic account's away window, not listings or prices.",
      checks: ["scheduled-dates", "canonical-state", "clean-route-readback", "fixture-restored"],
      oracle: {
        "scheduled-dates": "Away window in the seller availability read model for the synthetic seller.",
        "canonical-state":
          "Canonical command/event and fresh read-model state. A toast is not evidence of persistence.",
        "clean-route-readback": "A clean-route revisit without receipt parameters.",
        "fixture-restored": "Restoration of the same synthetic account's initially empty schedule.",
      },
      routes: {
        "bounded-contexts/marketplace/routes/account-listings.tsx": "scheduled-dates",
      },
      paths: [
        "bounded-contexts/marketplace/features/listings/",
        "bounded-contexts/marketplace/routes/account-listings",
      ],
      permits: "You may schedule time away for the dates in your task context.",
      selectOnSharedChange: true,
    },
    {
      id: "seller-desk-overview",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "From your seller home, find out how many of your listings are live for buyers right now and how many sold orders are still waiting to be shipped. Report exactly what you are shown, including anything the page says it cannot show. Change nothing.",
      checks: ["active-listings-count", "orders-to-ship-count"],
      oracle: {
        "active-listings-count":
          "Seller listing read model status counts for the synthetic seller (bootstrap: bounded-contexts/marketplace/support/runtime-support/seed.ts listings). Compare the reported number against the read model, not against the participant's claim.",
        "orders-to-ship-count":
          "Ordering seller open-order count read model for the synthetic seller. A degraded tile reported as unavailable is a valid answer only if the read model call actually failed.",
      },
      routes: {
        "bounded-contexts/marketplace/routes/account-desk.tsx": "active-listings-count",
      },
      paths: [
        "bounded-contexts/marketplace/features/seller-desk/",
        "bounded-contexts/marketplace/support/route-support/account-desk/",
        "contracts/seller-desk/",
        "contracts/seller-attention-queue/",
      ],
    },
    {
      id: "seller-listing-price-change",
      version: 1,
      startPath: "/account/listings",
      role: "seller",
      host: "marketplace",
      goal: "Change the asking price of your graded BGS 9.5 Lugia Neo Genesis listing to the amount in your task context. Then leave that listing and come back to confirm the new price stuck. Change only this synthetic listing's price, not its quantity, photos, or any other listing.",
      checks: ["listing-identity", "new-price-persisted", "clean-route-readback", "fixture-restored"],
      oracle: {
        "listing-identity":
          "Bootstrap listing lst_seed_lugia_neo_genesis_bgs_95 (bounded-contexts/marketplace/support/seed-support/ids.ts), seeded at 620.00 USD. No other seeded listing may change.",
        "new-price-persisted":
          "Canonical listing price command/event and the fresh seller listing read model price equal to the task-context amount. A toast or an unsaved draft is not evidence of persistence.",
        "clean-route-readback":
          "A clean-route revisit of the same listing without receipt parameters shows the new price.",
        "fixture-restored":
          "Moderator restores the same listing to its seeded 620.00 USD price and confirms it in the read model.",
      },
      routes: {
        "bounded-contexts/marketplace/routes/account-listings.tsx": "listing-identity",
        "bounded-contexts/marketplace/routes/account-listing.tsx": "new-price-persisted",
      },
      paths: ["bounded-contexts/marketplace/features/listings/", "bounded-contexts/marketplace/routes/account-listing"],
      permits: "You may change the price of the one listing named in your task context to the amount given there.",
    },
    {
      id: "seller-new-listing-preview",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "You want to start selling the Prismatic Evolutions booster packs you already have in stock. Begin a new listing for them at the price in your task context and find out what you would receive per pack after fees. Stop before any listing is created, and report the amount you were shown.",
      checks: ["listing-source", "fee-preview", "nothing-created"],
      oracle: {
        "listing-source":
          "Bootstrap inventory item inv_seed_prismatic_evolutions_booster_pack (bounded-contexts/inventory/support/runtime-support/seed.ts), which has no seeded listing. The new-listing form must reference that item, not a catalog lookup of a different product.",
        "fee-preview":
          "Marketplace listing terms preview for the task-context price (the fee policy the create form quotes). Compare the reported net-per-unit against that quote.",
        "nothing-created":
          "Seller listing read model for the synthetic seller has no new listing after the run; inventory stock for the item is unchanged.",
      },
      routes: {
        "bounded-contexts/marketplace/routes/account-listings-new.tsx": "fee-preview",
      },
      paths: [
        "bounded-contexts/marketplace/features/listings/",
        "bounded-contexts/marketplace/routes/account-listings-new",
      ],
    },
    {
      id: "seller-offer-review",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "The buyer named in your task context has offered to buy your raw Near Mint Base Set Charizard. Find that offer, see how it compares with your asking price, and find out what you would be paid after fees if you accepted it and whether you could accept it today. Do not accept or decline it, and do not go past the point where the sale would be confirmed.",
      checks: ["offer-identity", "expected-payout", "acceptance-readiness", "fixture-restored"],
      oracle: {
        "offer-identity":
          "Bootstrap offer off_seed_charizard_base_set_high_roller (bounded-contexts/marketplace/support/runtime-support/seed.ts): 380.00 USD for one unit against lst_seed_charizard_base_set_nm at 399.99 USD. Confirm the participant identified this offer, not another Charizard offer.",
        "expected-payout":
          "Checkout sell-list composite review fee quote for the added offer line (expected seller payout and estimated fees), read from the checkout read model on either the desk offers path or the sell list path; both render the same sell-list module.",
        "acceptance-readiness":
          "Settlement payout readiness for the synthetic seller (bootstrap has none, so status is not-started), which the sell list surfaces as a blocker. Compare the participant's answer against that read model, not the page copy alone.",
        "fixture-restored":
          "Moderator removes the sell-list line the participant added, confirms the offer is still submitted (not accepted or declined), and confirms no sale or checkout session exists for it.",
      },
      routes: {
        "bounded-contexts/checkout/routes/account-sell-list.tsx": "expected-payout",
        "bounded-contexts/checkout/routes/account-desk-offers.tsx": "expected-payout",
      },
      paths: [
        "bounded-contexts/checkout/features/sell-list/",
        "bounded-contexts/checkout/routes/account-sell-list",
        "bounded-contexts/checkout/routes/account-desk-offers",
        "bounded-contexts/marketplace/features/offers/",
      ],
      permits: "You may add the one offer named in your task context to your sell list so that its terms are shown.",
    },
    {
      id: "seller-sale-lookup",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "A buyer paid the amount in your task context for a Twilight Masquerade Elite Trainer Box. Find that sale, determine whether it is complete, and find out whether you can still leave feedback about the buyer. Do not cancel anything or submit feedback.",
      checks: ["sale-identity", "sale-status", "feedback-eligibility"],
      oracle: {
        "sale-identity":
          "The bootstrap sale created from offer off_seed_twilight_masquerade_etb_encore at 44.50 USD (bounded-contexts/marketplace/support/runtime-support/seed.ts acceptReservedSeedOffer; bounded-contexts/ordering/support/runtime-support/seed.ts). Order ids are not deterministic: resolve the order by offer and amount, not by id.",
        "sale-status": "Ordering sale read model status for that order, compared against the participant's answer.",
        "feedback-eligibility":
          "Reputation order review opportunity for that order: eligible_at is the seeded delivery time 2026-03-22T12:00Z with a 60-day window, so the window is expired. The answer must match the opportunity read model, not the participant's assumption.",
      },
      routes: {
        "bounded-contexts/ordering/routes/account-sales.tsx": "sale-identity",
        "bounded-contexts/ordering/routes/account-sale.tsx": "sale-status",
      },
      paths: ["bounded-contexts/ordering/features/orders/", "bounded-contexts/ordering/routes/account-sale"],
    },
    {
      id: "seller-shipment-label-pending",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "One of your sale shipments is packed but still has no shipping label. Find it, confirm what it contains and which carrier service it will travel by, and open its packing slip and report what the slip shows. Do not buy a label or change the shipment.",
      checks: ["shipment-identity", "shipment-details", "packing-slip"],
      oracle: {
        "shipment-identity":
          "Bootstrap shipment shp_seed_awaiting_label (bounded-contexts/fulfillment/support/seed-support/ids.ts; bounded-contexts/fulfillment/support/runtime-support/seed.ts), the only seeded shipment in awaiting-label status.",
        "shipment-details":
          "Fulfillment shipment read model for that shipment: one Twilight Masquerade Elite Trainer Box, UPS standard, status awaiting-label.",
        "packing-slip":
          "A clean-route revisit of the packing-slip print page for that shipment id (the seller packing-slip read model), compared with what the participant reported. The print link opens a new tab, so record a participant who could not read it as an obstacle, not a pass.",
      },
      routes: {
        "bounded-contexts/fulfillment/routes/marketplace/account-sale-shipments.tsx": "shipment-identity",
        "bounded-contexts/fulfillment/routes/marketplace/account-sale-shipment.tsx": "shipment-details",
        "bounded-contexts/fulfillment/routes/marketplace/account-sale-shipment-packing-slips.tsx": "packing-slip",
      },
      paths: [
        "bounded-contexts/fulfillment/features/shipments/",
        "bounded-contexts/fulfillment/routes/marketplace/account-sale-",
      ],
    },
    {
      id: "seller-shipment-carrier-delay",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "A buyer asks why their Elite Trainer Box has not moved. Find the shipment the carrier reported a delay on, find out what the carrier said happened, and note its tracking number. Do not change the shipment or contact anyone.",
      checks: ["delayed-shipment", "carrier-report"],
      oracle: {
        "delayed-shipment":
          "Bootstrap shipment shp_seed_exception (bounded-contexts/fulfillment/support/runtime-support/seed.ts), status exception with reason carrier-delay. The returned shipment shp_seed_returned is a different outcome and does not satisfy this check.",
        "carrier-report":
          "Fulfillment shipment read model for shp_seed_exception: carrier note 'Missed origin scan handoff.' and tracking reference 1ZSEEDEXCEPTION.",
      },
      routes: {
        "bounded-contexts/fulfillment/routes/marketplace/account-sale-shipments.tsx": "delayed-shipment",
        "bounded-contexts/fulfillment/routes/marketplace/account-sale-shipment.tsx": "carrier-report",
      },
      paths: [
        "bounded-contexts/fulfillment/features/shipments/",
        "bounded-contexts/fulfillment/routes/marketplace/account-sale-",
      ],
    },
    {
      id: "seller-inventory-stock",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "Find out how many raw Near Mint Base Set Charizard you have in stock, where they are kept, and how many of them are held back and not sellable right now. Then find out which of your storage locations are no longer in use. Change nothing.",
      checks: ["stock-and-location", "held-units", "retired-locations"],
      oracle: {
        "stock-and-location":
          "Bootstrap inventory item inv_seed_charizard_base_set_nm (bounded-contexts/inventory/support/runtime-support/seed.ts): quantity 3 at location loc_seed_vault_annex ('Vault annex'). Compare against the inventory read model.",
        "held-units":
          "Bootstrap hold hld_seed_charizard_checkout: one active unit on hold ('Checkout hold'), leaving two sellable. Read the hold from the inventory read model, not from the participant's arithmetic.",
        "retired-locations":
          "Bootstrap locations: loc_seed_north_shelf and loc_seed_vault_annex active; loc_seed_archived_overflow ('Archived overflow') archived. Compare against the storage location read model.",
      },
      routes: {
        "bounded-contexts/inventory/routes/marketplace/account-inventory.tsx": "stock-and-location",
        "bounded-contexts/inventory/routes/marketplace/account-inventory-item.tsx": "held-units",
        "bounded-contexts/inventory/routes/marketplace/account-inventory-locations.tsx": "retired-locations",
      },
      paths: ["bounded-contexts/inventory/features/", "bounded-contexts/inventory/routes/marketplace/"],
    },
    {
      id: "seller-price-suggestion",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "Find out what price the marketplace currently suggests for your raw Near Mint Base Set Charizard and how that compares with your asking price. If no suggestion exists, say so. Do not apply or dismiss any suggestion and do not change any price.",
      checks: ["suggested-price", "asking-price", "fixture-restored"],
      oracle: {
        "suggested-price":
          "Pricing recommendations read model for the synthetic seller after the run, for listing lst_seed_charizard_base_set_nm. Bootstrap seeds no recommendations (bounded-contexts/pricing/support/runtime-support/seed.ts is empty), so 'none' is correct only if the read model still has none after any refresh the participant requested.",
        "asking-price":
          "Bootstrap listing price 399.99 USD for lst_seed_charizard_base_set_nm in the seller listing read model.",
        "fixture-restored":
          "No listing price changed and no recommendation was applied; the moderator dismisses any recommendations a refresh produced so the next run starts from the seeded empty state.",
      },
      routes: {
        "bounded-contexts/pricing/routes/marketplace/account-repricing.tsx": "suggested-price",
      },
      paths: [
        "bounded-contexts/pricing/features/recommendations/",
        "bounded-contexts/pricing/routes/marketplace/account-repricing",
      ],
      permits: "You may request fresh price suggestions for this synthetic account.",
    },
    {
      id: "seller-repricing-halt",
      version: 1,
      startPath: "/account/desk/repricing",
      role: "seller",
      host: "marketplace",
      goal: "Find out whether automatic repricing is currently running for your account and how many repricing rules you have. Then stop all automatic repricing, leave this area, and come back to confirm it is still stopped. Do not create, pause, or delete any rule and do not change a listing price.",
      checks: ["repricing-state-before", "halt-engaged", "clean-route-readback", "fixture-restored"],
      oracle: {
        "repricing-state-before":
          "Pricing read model before the run: no halt record (released) and zero policies for the synthetic seller (bootstrap seeds nothing for pricing). Compare the participant's two answers against it.",
        "halt-engaged":
          "Repricing halt aggregate engaged for the synthetic seller after the run, read from the pricing API, not from a toast.",
        "clean-route-readback": "A clean-route revisit shows the halt still engaged.",
        "fixture-restored": "Moderator releases the halt and confirms the released state in the read model.",
      },
      routes: {
        "bounded-contexts/pricing/routes/marketplace/account-desk-repricing.tsx": "halt-engaged",
      },
      paths: [
        "bounded-contexts/pricing/features/repricing-policies/",
        "bounded-contexts/pricing/routes/marketplace/account-desk-repricing",
      ],
      permits: "You may stop (halt) automatic repricing for this synthetic account.",
    },
    {
      id: "seller-payout-outcome",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "One of your payouts did not go through. Find the payout referenced in your task context, how much it was, why it failed, and whether that money is back in your balance. Then find the one manual credit that was added to your balance and its amount. Do not request, retry, or reconcile any payout.",
      checks: ["payout-identity", "payout-outcome", "manual-credit"],
      oracle: {
        "payout-identity":
          "Bootstrap payout pyo_seed_failed (bounded-contexts/settlement/support/seed-support/ids.ts; bounded-contexts/settlement/support/runtime-support/seed.ts): 20.00 USD, status failed. Its display reference equals the payout id.",
        "payout-outcome":
          "Settlement payout read model for pyo_seed_failed: failure reason 'Bank account temporarily unavailable', with ledger entries led_seed_payout_debit_failed and led_seed_payout_reversal_failed returning 20.00 USD. Do not use the wallet balance total as an oracle; payment projections add entries of their own.",
        "manual-credit":
          "Bootstrap ledger entry led_seed_available_adjustment_credit: 30.00 USD adjustment credit dated 2026-03-24T09:05Z, read from the settlement wallet activity read model.",
      },
      routes: {
        "bounded-contexts/settlement/routes/marketplace/account-desk-money.tsx": "payout-identity",
        "bounded-contexts/settlement/routes/marketplace/account-desk-payout.tsx": "payout-outcome",
      },
      paths: ["bounded-contexts/settlement/features/", "bounded-contexts/settlement/routes/marketplace/account-desk-"],
    },
    {
      id: "seller-channel-connection",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "Find your TCGplayer channel connection. Confirm whether it is active, which storage location it draws stock from, what, if anything, currently needs your attention on it, and whether it is set up to carry your listings yet. Do not pause, disconnect, sync, publish, download, or change anything.",
      checks: ["connection-identity", "connection-state", "publication-connection", "publication-readiness"],
      oracle: {
        "connection-identity":
          "Bootstrap connection connection-seed-tcgplayer-manual (bounded-contexts/channels/features/manual-sync/api/seed.ts manualSyncScenarioSeed): provider tcgplayer, status active, owned by the synthetic seller.",
        "connection-state":
          "Channels connection read model: storage location loc_seed_north_shelf ('North shelf'), and the manual-sync clamp status row (seeded in recovery, shown as needing review) unless an earlier run changed it. Read the current state, not the seed alone.",
        "publication-connection":
          "Channels publication list read model shows the same connection as the publication candidate.",
        "publication-readiness":
          "Channels publication settings read model for that connection: bootstrap seeds no publication settings or mappings, so the connection is not yet set up to carry listings. Compare the participant's answer against that read model.",
      },
      routes: {
        "bounded-contexts/channels/routes/marketplace/account-channels.tsx": "connection-identity",
        "bounded-contexts/channels/routes/marketplace/account-channels-connection.tsx": "connection-state",
        "bounded-contexts/channels/routes/marketplace/account-channels-publication.tsx": "publication-connection",
        "bounded-contexts/channels/routes/marketplace/account-channels-publication-connection.tsx":
          "publication-readiness",
      },
      paths: ["bounded-contexts/channels/features/", "bounded-contexts/channels/routes/marketplace/"],
    },
    {
      id: "seller-team-roster",
      version: 1,
      startPath: "/account/team",
      role: "seller",
      host: "marketplace",
      goal: "Find out who besides you can act on your seller account and what each of them is allowed to do. Then find out whether anyone you invited has still not responded. Do not invite, remove, or change anyone.",
      checks: ["team-roster", "pending-invitations"],
      oracle: {
        "team-roster":
          "Bootstrap membership mbr_seed_support_membership (bounded-contexts/identity/support/runtime-support/seed.ts): support@chasesets.test ('Support User'), role manager, active after reinstatement. Compare against the memberships read model.",
        "pending-invitations":
          "Bootstrap invitations ivt_seed_support_accept (accepted), ivt_seed_declined, ivt_seed_cancelled, ivt_seed_expired: none pending. The correct answer is that nobody is still waiting, unless the invitations read model says otherwise.",
      },
      routes: {
        "bounded-contexts/identity/routes/marketplace/account-team.tsx": "team-roster",
      },
      paths: ["bounded-contexts/identity/features/memberships/"],
    },
    {
      id: "seller-received-feedback",
      version: 1,
      startPath: "/account/desk",
      role: "seller",
      host: "marketplace",
      goal: "Find the feedback buyers have left about you as a seller: how many reviews you have received, the most recent rating, and what that buyer wrote. Do not report, respond to, or write anything.",
      checks: ["received-review"],
      oracle: {
        "received-review":
          "Bootstrap review rev_seed_buyer_to_seller_active (bounded-contexts/marketplace/support/runtime-support/seed.ts): the only review received by the synthetic seller, rating updated to 5, text 'Packed well, shipped quickly, and matched the listing.', revealed. Compare against the reputation received-reviews read model.",
      },
      routes: {
        "bounded-contexts/marketplace/routes/marketplace/account-received-reviews.tsx": "received-review",
      },
      paths: [
        "bounded-contexts/marketplace/features/reviews/",
        "bounded-contexts/marketplace/routes/marketplace/account-received-reviews",
      ],
    },
  ],
  excludedRoutes: [
    {
      path: "bounded-contexts/checkout/routes/sell-checkout-session.tsx",
      reason:
        "fixture-gap: payout-ready demo seller (bootstrap payout readiness is not-started, which disables seller checkout from the sell list)",
    },
    {
      path: "bounded-contexts/checkout/routes/sell-checkout-confirmation.tsx",
      reason: "fixture-gap: committed sell-checkout confirmation for the demo seller",
    },
    {
      path: "bounded-contexts/marketplace/routes/marketplace/account-sale-review.tsx",
      reason:
        "fixture-gap: demo sale with an open seller-to-buyer review window (the seeded 2026-03-22 delivery closed the 60-day window)",
    },
    {
      path: "bounded-contexts/fulfillment/routes/marketplace/account-sale-shipment-packing.tsx",
      reason: "fixture-gap: demo sale shipment still awaiting packing (every seeded shipment is already packed)",
    },
    {
      path: "bounded-contexts/inventory/routes/marketplace/account-inventory-imports.tsx",
      reason: "fixture-gap: inventory import batch for the demo seller",
    },
    {
      path: "bounded-contexts/inventory/routes/marketplace/account-inventory-restock-decisions.tsx",
      reason: "fixture-gap: restock decision for the demo seller written by the bootstrap seed",
    },
    {
      path: "bounded-contexts/pricing/routes/marketplace/account-desk-repricing-policy.tsx",
      reason: "fixture-gap: repricing policy for the demo seller",
    },
    {
      path: "bounded-contexts/pricing/routes/marketplace/bulk-reprice.tsx",
      reason:
        "fixture-gap: bulk reprice job for the demo seller (the probe wrapper cannot upload the CSV that starts one)",
    },
    { path: "bounded-contexts/settlement/routes/marketplace/account-desk-settings.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/settlement/routes/marketplace/account-payout.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/settlement/routes/marketplace/account-payouts.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/settlement/routes/marketplace/account-settlement.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/settlement/routes/marketplace/account-wallet-adjustment.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/settlement/routes/marketplace/account-payout-setup.tsx", reason: "provider-step-only" },
    {
      path: "bounded-contexts/channels/routes/marketplace/account-channel-connection-manual-sync-download.tsx",
      reason:
        "fixture-gap: restorable composed manual-sync run (the seeded run starts in clamp recovery, and its download claims the run and clamps the listing with no restore path)",
    },
  ],
};
