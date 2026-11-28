# Marketplace browser coverage on the Corten marketplace

The Corten marketplace serves production in place of marketplace-web. This table says where each of
marketplace-web's browser specs (`deployables/marketplace/e2e`) is covered now, so retiring
marketplace-web drops no coverage without a recorded reason.

1. **Retargeted**: the spec now lives in `deployables/corten-pilot/e2e` and runs against the Corten
   marketplace in Platform PR's Corten Marketplace Browser Tests. Tests that read marketplace-web's
   own DOM shape are skipped there, each with a
   `test.skip(onCortenMarketplace, "<reason>")`.
2. **Covered**: the behavior is tested by the named Rust tests in `marketplace/src/tests.rs`, which
   run in Corten Pilot Check.
3. **Dropped**: the spec tests marketplace-web's own machinery, or nothing the Corten marketplace has; the
   reason is given.

Counts are test declarations (`test(`) in each file and the tests skipped by an
`onCortenMarketplace` condition. A Corten-specific branch inside a test is not a skip.

## Interaction boundaries

| When a visitor… | Behavior to preserve |
| --- | --- |
| Changes presentation of data already on screen | No request. For example, switch the item photo, filter a stock ledger, or change the packing-slip paper size without replacing the content or clearing a draft. If the view has a shareable URL, a reload must render the same choice. |
| Requests more data or submits an action without changing location | Patch the owning component. Search's **Load more** appends rows; notification **Mark read** refreshes the feed from the server's answer. Neither should reset the shell or add history. |
| Changes a filter, variant, or market-book tab that affects server data, live subscriptions, or other forms | Navigate to the canonical GET in place. Keep scroll and keyboard focus on the control, or on a stable neighbor if it disappears. Back and Forward should restore the address and corresponding results. Keep a working link or form without JavaScript. |
| Opens another item, account, or checkout | Treat it as a destination. Follow the link, start at the top or an intentional fragment, and leave modified clicks and new tabs alone. Never replay a purchase to restore a view. |

The interaction cases registered by `critical-flows.spec.ts` exercise the item and search paths below the fold, including keyboard focus, history and JavaScript-off fallback. Packing-slip and inventory browser smokes cover the request-free choices.

## Retargeted

| Spec | Tests | Skipped on Corten |
| --- | --- | --- |
| `critical-flows.spec.ts` | 19 | 9 |
| `buyer-purchase-journey.spec.ts` | 3 | 2 |
| `marketplace-navigation.spec.ts` | 3 | 3 |
| `marketplace-shell-header.spec.ts` | 13 | 1 |
| `responsive-evidence-contract.spec.ts` | 13 | 0 |
| `search-scroll-restoration.spec.ts` | 4 | 2 |

## Covered or dropped

| Spec | Suite | Disposition | Rust tests |
| --- | --- | --- | --- |
| `accepted-offer-sales-handoff` | `marketplace_seller` | Covered | `the_submitted_offers_show_each_offer_with_its_status_and_changes`, `a_sale_card_shows_the_sellers_payout_and_a_data_client_gets_the_list` |
| `account-elevation-intent` | `marketplace_account` | Covered | `a_purchase_intent_is_the_pilots_page_and_submit_offer_shows_the_offer`, `a_guest_saves_a_watch_alert_as_an_intent_and_registers_to_claim_it` |
| `account-form-pending` | `marketplace_account` | Dropped: marketplace-web's own pending-submit state; the pilot's forms are Corten's submit queue (busy and double-submit are Corten's smoke). Address writes are covered | `an_added_address_is_read_after_its_write_and_the_page_says_it_was_saved`, `an_address_write_without_an_answer_is_asked_about_and_one_that_cannot_be_confirmed_holds_its_form` |
| `account-management-interruption` | `marketplace_account` | Dropped: marketplace-web's keyed router and in-memory key secret handling. The same outcomes are covered | `a_profile_update_without_an_answer_is_asked_about_and_one_that_cannot_be_confirmed_holds_the_form`, `a_key_write_without_an_answer_is_asked_about_and_its_lost_secret_is_said`, `a_new_or_rotated_key_shows_its_secret_once_in_the_writes_own_answer`, `an_address_write_without_an_answer_is_asked_about_and_one_that_cannot_be_confirmed_holds_its_form`, `revoke_access_is_an_attempt_believed_only_from_its_own_receipt` |
| `account-payment-stripe-embed.uat` | `stripe-embed-uat` | Manual staging-only Payment Element confirmation (4242) and webhook capture. The manual config validates the test key and staging origin before launching a browser. Excluded from PR CI and the shared Playwright projects; see the [money operations runbook](../../../docs/runbooks/money-operations.md#stripe-embed-confirmation-uat). | none |
| `account-payment` | `marketplace_checkout` | Covered | `checkout_received_shows_the_started_payment_and_continues_to_marketplaces_payment_page`, `a_guests_started_payment_continues_on_the_guest_payment_page`, `a_claim_links_token_is_typed_only_where_the_page_shows_it` |
| `agent-grant-revocation-real-route` | `marketplace_account` | Covered | `revoke_access_is_an_attempt_believed_only_from_its_own_receipt`, `a_revoke_or_switch_is_read_after_its_write_and_a_failed_one_says_what_the_session_is_now`, `a_grant_shows_its_scopes_spend_mandate_webhook_and_activity` |
| `auth-form-pending` | `marketplace_account` | Covered (no-JavaScript sign-in); double submit is Corten's submit queue | `a_signed_out_visitor_signs_in_on_the_pilot`, `a_password_starts_the_session_and_goes_back_to_the_pilot_or_marketplace`, `a_refused_sign_in_says_why_on_the_same_step` |
| `browser-route-modules` | `marketplace_checkout` | Dropped: evaluates marketplace-web's React route module graph and hydration; the pilot has no route modules. Guest line review is covered | `a_line_the_api_did_not_present_needs_review_and_holds_the_checkout`, `a_guest_cart_is_the_cart_page_with_its_lines_total_and_offer` |
| `buy-funnel-redesign` | `marketplace_checkout` | Covered | `the_cart_shows_each_line_the_total_and_the_lower_price_the_api_offers`, `an_empty_cart_offers_to_keep_shopping`, `a_cart_that_cannot_check_out_says_which_lines_need_attention`, `the_checkout_shows_the_session_payments_quote_the_wallet_and_the_saved_address`; signed-out session recovery is in the retargeted `critical-flows.spec.ts` |
| `channel-connection-connect` | `marketplace_account` | Covered | `channels_connects_pauses_activates_and_says_what_was_refused`, `channels_lists_the_connections_by_status_and_page_and_shows_a_connections_status_and_setup` |
| `channel-connection-states.evidence` | `marketplace_account` | Dropped: screenshot evidence of marketplace-web's design-system states | `channels_lists_the_connections_by_status_and_page_and_shows_a_connections_status_and_setup` |
| `channel-publication-freshness` | `marketplace_account` | Covered | `a_publication_write_waits_for_its_version_and_says_what_was_refused`, `a_connections_publication_shows_its_settings_blocked_listings_and_mappings` |
| `facet-section-list.evidence` | `marketplace_browse` | Dropped: geometry evidence of marketplace-web's facet sheet. The pilot's facets are covered, and their layout by the kept responsive-evidence-contract spec | `a_facets_choices_past_six_wait_behind_show_more_and_a_long_facet_has_a_search` |
| `ink-foil-visual-identity.evidence` | `marketplace_browse` | Dropped: screenshot evidence of marketplace-web's theme; the pilot's tokens are exported from the same sources (export --check) | none |
| `inventory-recovery` | `marketplace_seller` | Covered | `the_list_shows_archived_locations_and_data_clients_get_the_screen`, `saving_and_archiving_patch_the_location`, `an_action_its_page_cannot_confirm_turns_writes_off_until_the_page_checks_it` |
| `invitation-acceptance` | none | Dropped: the file is empty | none |
| `item-detail` | `marketplace_browse` | Covered; dock and options layout by the kept responsive-evidence-contract spec | `anyone_reads_an_item_with_its_best_listing_and_its_market`, `an_option_is_a_link_that_chooses_it_and_any_takes_it_away`, `the_mobile_dock_links_to_the_rail_on_each_side_or_to_the_options`, `the_details_tab_lists_the_fields_and_the_records_they_relate_to`, `the_sales_tab_reads_the_products_market_history_with_the_page_and_draws_its_chart` |
| `listing-evidence-readiness` | `marketplace_seller` | Covered | `publish_goes_to_the_listing_says_when_evidence_blocks_it_and_keeps_a_refused_draft`, `a_sellers_listing_shows_its_overview_fees_readiness_and_forms_and_only_a_draft_its_photos`, `create_listing_reads_the_sellers_inventory_and_only_a_listing_manager_writes` |
| `manual-sync-recovery` | `marketplace_account` | Covered | `a_connections_manual_sync_shows_channels_panel_and_its_writes`, `create_hold_and_release_confirm_their_attempts`, `a_refused_hold_or_release_is_its_form_again` |
| `market-following-offers` | `marketplace_account` | Covered | `market_following_lists_the_policies_and_opens_one_with_its_steps`, `a_first_preview_creates_the_policy_and_authorize_needs_consent`, `a_step_with_no_answer_is_looked_up_once_and_an_unconfirmed_one_turns_the_steps_off`, `the_offer_matches_show_the_snapshot_and_each_match_with_its_actions` |
| `notifications` | `marketplace_account` | Covered | `the_feed_shows_each_notification_its_source_and_time_and_open_stays_here_or_goes_to_marketplace`, `the_settings_show_the_channels_the_page_has_words_for_and_the_accounts_alerts`, `a_link_to_the_retired_notification_sheet_goes_to_the_notification_center` |
| `pricing-health-apply-goal` | `marketplace_seller` | Covered | `pricing_health_computes_compares_and_applies_a_goal_and_says_what_was_refused` |
| `pricing-health-compare-goals` | `marketplace_seller` | Covered | `pricing_health_shows_a_policys_verdict_its_goals_compared_and_the_platforms_grades` |
| `pricing-health-verdict` | `marketplace_seller` | Covered | `pricing_health_shows_a_policys_verdict_its_goals_compared_and_the_platforms_grades` |
| `pricing-health-what-if` | `marketplace_seller` | Covered | `pricing_health_computes_compares_and_applies_a_goal_and_says_what_was_refused` |
| `rendered-copy-sweep` | `rendered_copy` | Dropped: censuses marketplace-web's rendered strings; the pilot's copy is exported from the same catalogs and export --check is required | none |
| `repricing-policies` | `marketplace_seller` | Covered | `a_policys_page_reads_the_policy_then_its_halt_changes_and_activity`, `a_policys_writes_go_back_to_it_with_their_receipt_and_delete_goes_to_the_list`, `a_policys_editor_posts_draw_it_again_and_save_revises_the_policy` |
| `saved-list-addition` | `marketplace_browse` | Covered | `add_to_list_opens_a_dialog_the_page_drew_with_the_accounts_recent_lists`, `add_product_adds_to_a_new_or_a_recent_list_and_the_page_says_where_it_went`, `a_guests_add_to_list_is_an_intent_they_register_to_claim` |
| `search-price-filter-layout` | `marketplace_browse` | Covered; the pilot's filters are a GET form with no hydration step, and their layout is in the kept responsive-evidence-contract spec | `the_filters_and_pages_are_links_that_keep_each_other`, `search_sends_its_terms_and_draws_results_filters_and_load_more` |
| `sell-checkout-session` | `marketplace_checkout` | Covered | `checkout_start_for_the_cart_reads_its_readiness_and_a_refusal_shows_its_recovery`, `an_accounts_sell_list_shows_each_lines_readiness_the_payout_in_cents_and_continue` |
| `sell-list-evidence` | `marketplace_checkout` | Covered | `a_line_missing_evidence_or_payouts_not_set_up_holds_continue_back_and_says_why` |
| `seller-desk-journey.uat` | `seller-desk-web` | Covered | `the_desk_shows_the_queue_in_its_own_words_and_the_counts_it_could_read`, `a_desk_whose_reads_fail_says_so_and_never_blanks`, `the_money_page_shows_the_wallet_the_payouts_and_what_needs_a_next_step` |
| `seller-time-away-capacity` | `marketplace_account` | Covered | `a_setting_that_applies_goes_back_to_the_list_saying_what_it_set`, `a_setting_refused_is_the_list_again_with_the_words_by_its_field`, `while_a_setting_catches_up_the_list_shows_what_was_set` |
| `shipment-mutation-recovery` | `browser-e2e-dev-source` | Dropped: marketplace-web's encrypted browser recovery descriptors; the pilot holds no recovery state in the browser. Lost packing answers are covered | `an_action_the_api_cannot_confirm_turns_writes_off_until_the_page_checks_it`, `a_write_the_page_cannot_confirm_turns_the_writes_off_until_the_api_can_say` |
| `support-case-detail` | `marketplace_account` | Covered | `a_support_case_shows_who_acts_next_and_only_the_viewers_part`, `the_support_page_lists_each_sides_cases_with_their_remedy_and_the_flows` |
| `support/auth-trace-artifact.probe` | none | Dropped: an operator probe of Auth's registration trace, not a marketplace screen; registration is covered | `a_password_registration_resolves_consent_first_and_lands_on_the_account_read_after_the_write` |
