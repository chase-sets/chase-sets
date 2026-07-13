# Open-Offer Demo Walkthrough

This is the 30-second operator script for issue #4073's Shorts/TikTok/X asset. It follows the open-offers spearhead shipped in PR #4945 and [Claim 4](./offer-economics-claims-substantiation.md#claim-4--open-offers). The recording is a real staging walkthrough, but it must be labeled `Staging demo`; it must not imply live buyer or seller activity.

## Prerequisites

TODD prepares two staging accounts that are not the same account:

- Buyer account: `offers.view` and a valid shipping destination.
- Seller account: `offers.view`, `offers.manage`, `listings.view`, matching active inventory/supply, and seller listing availability enabled.
- One catalog item/product shared by the offer and seller supply. Use a non-sensitive representative fixture item.
- A price and quantity that pass the live offer-abuse and fee-quote policies. Do not display email, address, phone, account IDs, certification numbers, or payment credentials.

Run the representative-commerce-state workflow if staging lacks this state. Confirm both `/account/offers/submitted` and `/account/offers/matches` load before recording.

## 30-second shot list

| Time | Picture | Voice/caption | Truth reference |
|---|---|---|---|
| 0–3s | Tight crop of a generic social-group “ISO” composition; no platform name, logo, username, or real post. | “An ISO post depends on the right seller seeing it.” | Contrast setup only; no product claim. |
| 3–10s | Buyer selects the catalog-backed item, enters price/quantity, and submits. End on Submitted Offers. | “Post an open offer for the card you want.” | Claim 4 short CTA. |
| 10–18s | Hard cut to the seller's Offer Matches list, then the matching detail and fee quote. | “Any matching seller can accept it.” | Claim 4; show no match count. |
| 18–25s | Seller accepts after the fee terms are visible. Hold on accepted state. | “Acceptance records the terms and starts the checkout and order handoff.” | Claim 4 exact mechanics. |
| 25–30s | Buyer accepted-offer/checkout handoff, then Chase Sets wordmark and waitlist CTA. | “A real marketplace workflow, not a forum thread.” On-screen: `Staging demo · Join the waitlist`. | Claim 4; do not show payment completion unless separately captured and substantiated. |

## Capture sequence

1. Record at 1080×1920 with browser chrome and debug overlays hidden. Keep the pointer visible only for the submit and accept actions.
2. Buyer: open the selected catalog item and submit the offer. Capture the submitted confirmation and `/account/offers/submitted/{offerId}`.
3. Seller: switch accounts without exposing credentials. Open `/account/offers/matches`, select the offer, pause on the fee quote, then accept.
4. Buyer: return to the accepted-offer checkout handoff. Stop before any payment credential or destructive provider action.
5. Record a separate generic ISO contrast plate. Do not capture a real Facebook group or imply endorsement/affiliation.
6. Export one clean master; derive platform crops without changing captions or claims.

## Honest owner split

- **Machinery in repo:** route sequence, approved captions, truth gate, privacy exclusions, and acceptance checks.
- **TODD:** staging accounts/data, generic ISO plate, screen recording, voiceover, music/license, edit, captions, thumbnails, native exports, and final operator review.

## Acceptance checklist

- The demo says `Staging demo` and shows no invented counts, expiry, fill-time, or completed-payment claim.
- Buyer and accepting seller are distinct; the seller has matching active supply.
- The fee quote appears before acceptance; the handoff appears after acceptance.
- All private data is cropped or replaced with representative non-sensitive values.
- Spoken and on-screen offer wording matches Claim 4 exactly or uses its shorter approved CTA.
- TODD stores raw footage and exports outside git; only the final hosted asset URL should replace PR #4945's reserved landing slot in a later issue.
