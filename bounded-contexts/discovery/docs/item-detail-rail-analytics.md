# Item Detail Rail Analytics

The simplified item-detail rail emits provider-neutral analytics for the Buy, Sell, and Watch workflows. Discovery owns the browser event contract because it owns the item-detail selection surface. The marketplace deployable owns the bridge endpoint and observability recording.

## Browser Event

Rails dispatch a `CustomEvent` named `chase-sets:item-detail-rail-analytics`. The marketplace root listens for that event and posts allowlisted labels to `/analytics/item-detail-rail`.

The event detail must contain `event` plus optional bounded labels:

- `intent`: `buy`, `sell`, `watch`, or `unknown`
- `workflow`: selected workflow such as `selected_listing`, `best_available_listing`, `selected_product`, `make_offer`, `selected_offer`, `best_offer`, `create_listing`, `watch_listings`, or `watch_offers`
- `selection`: `explicit`, `implicit`, or `none`
- `topic`: reference-info topic such as `listing_checkout`, `listing_buy_cart`, `product_buy_cart`, `make_offer`, `estimated_payout`, `accept_offer`, `offer_sell_list`, `product_sell_list`, `create_listing`, `listing_alert`, or `offer_alert`
- `outcome`: bounded outcome such as `opened`, `shown`, or `unavailable`
- `gate`: deferred registration or commitment gate such as `accept_offer`, `create_listing`, or `buyer_registration`
- `viewer`: `guest`, `signed_in`, or `unknown`
- `surface`: `desktop_rail`, `mobile_action_bar`, `action_rail`, `market_book`, `reference_info`, `similar_items`, or `guest_registration`

Labels must be ASCII, 80 characters or shorter, and match `[a-zA-Z0-9_.-]+`.

## Events

- `rail_intent_selected`: top-level Buy/Sell/Watch intent changed.
- `workflow_selected`: rail accordion or market-book workflow selected.
- `similar_item_selected`: a visitor followed a Similar Items card link. It records only `surface=similar_items` and `selection=implicit`, never either catalog item identifier.
- `reference_info_opened`: shared design-system Reference Info popup opened.
- `payout_preview_shown`: selected-offer seller payout preview was visible.
- `standard_preview_unavailable`: selected-offer standard terms preview could not be shown.
- `registration_gate_shown`: deferred registration gate was rendered.
- `registration_started`: deferred registration/sign-in CTA was clicked.
- `intent_submit_started`: final rail action submission started.
- `validation_failed`: rail form rendered a bounded validation/error state.
- `registration_return_completed`: reserved for signed-in return flows.
- `term_delta_reviewed`: reserved for final-term review outcomes.
- `intent_persisted`: reserved for anonymous Buy Cart, Sell List, listing draft, or Watch intent persistence outcomes.
- `commit_gate_reached`: reserved for checkout or seller-commit review gates.

## Privacy Contract

Rail analytics must not include product IDs, listing IDs, offer IDs, account IDs, account-specific agreement IDs, fee quote fingerprints, raw prices, payout amounts, addresses, emails, shipping destinations, buyer contact fields, or private account-specific transaction terms.

Reference Info analytics record topic and open outcome only. Payout analytics record preview visibility and source category through bounded labels, not monetary values or fee details.

Similar Items analytics records only the event, surface, and implicit-selection labels. Source and destination item IDs, titles, ranks, similarity scores, and category values are prohibited.

## Observability

`/analytics/item-detail-rail` records accepted events to `chase_sets_marketplace_item_detail_rail_events_total` with bounded labels. Unsupported event names and invalid labels are rejected before logging.
