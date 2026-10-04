export default {
  id: "guest",
  routeScope: [
    "^bounded-contexts/public-presence/routes/(marketplace|developers)/",
    "^bounded-contexts/commercial-terms/routes/public/",
    "^bounded-contexts/discovery/routes/(search|set|item-detail|item-detail-market-history|public-account|public-listing)\\.tsx$",
    "^bounded-contexts/pricing/routes/marketplace/market-price-history\\.tsx$",
    "^bounded-contexts/auth/routes/marketplace/(sign-in|sign-in-magic|register|invite|sign-out|guest-checkout-exit)\\.tsx$",
    "^deployables/(marketplace|public-web)/app/routes/",
  ],
  goals: [
    {
      id: "condition-policy",
      version: 1,
      startPath: "/help",
      role: "guest",
      host: "public-web",
      goal: "A card arrived in worse condition than its listing. Find where to report it, the reporting deadline after delivery, and who pays return shipping. Do not open a case or contact anyone. Explain any uncertainty or inconsistent guidance.",
      checks: ["report-location", "deadline", "return-shipping"],
      oracle: {
        "report-location":
          "Compare the report location against the authoritative policy, not just the participant's first page.",
        deadline:
          "Compare the reporting deadline against the authoritative policy, not just the participant's first page.",
        "return-shipping":
          "Compare return shipping responsibility against the authoritative policy, not just the participant's first page.",
      },
      routes: {
        "bounded-contexts/public-presence/routes/marketplace/help.tsx": "report-location",
        "bounded-contexts/public-presence/routes/marketplace/help-article.tsx": "deadline",
      },
      paths: ["bounded-contexts/public-presence/", "bounded-contexts/settlement/"],
      selectOnSharedChange: true,
    },
    {
      id: "landing-waitlist",
      version: 1,
      startPath: "/",
      role: "guest",
      host: "public-web",
      goal: "You collect and occasionally sell trading cards and just heard about Chase Sets. Find out what a seller pays on a sale here and whether buyers see the full delivered price before they pay. Then request early access with the email address in your task context, and report what you were told happens next. Do not provide any other personal details.",
      checks: ["seller-cost", "early-access-confirmation", "signup-restored"],
      oracle: {
        "seller-cost":
          "Compare the reported seller fee and payment-processing treatment against the public fee policy read the landing page renders from, not the participant's paraphrase.",
        "early-access-confirmation":
          "Confirm the welcome confirmation was reached for the task-context address, and that exactly one waitlist signup exists for it in the public-presence waitlist read model.",
        "signup-restored":
          "Confirm the synthetic signup is withdrawn or the isolated sandbox is reset before the next run so the address can be reused.",
      },
      routes: {
        "bounded-contexts/public-presence/routes/marketplace/home.tsx": "seller-cost",
        "bounded-contexts/public-presence/routes/marketplace/welcome.tsx": "early-access-confirmation",
      },
      paths: ["bounded-contexts/public-presence/features/waitlist/"],
      permits: "You may request early access once, using only the email address in your task context.",
    },
    {
      id: "help-center-selling",
      version: 1,
      startPath: "/help",
      role: "guest",
      host: "public-web",
      goal: "You are about to sell cards here for the first time. Find out when you are paid after a sale and what you must do when shipping an order. Do not contact anyone. Report anything that is unclear or contradictory.",
      checks: ["help-home", "selling-category", "seller-answers"],
      oracle: {
        "help-home":
          "Confirm from the recorded observations that the participant started at the help hub and chose a seller topic from it.",
        "selling-category":
          "Confirm from the recorded observations that the selling topic list was opened and the articles were chosen from it.",
        "seller-answers":
          "Compare the reported payout timing and shipping obligations against the published Getting paid and Shipping requirements help articles, not the participant's first page.",
      },
      routes: {
        "bounded-contexts/public-presence/routes/marketplace/help.tsx": "help-home",
        "bounded-contexts/public-presence/routes/marketplace/help-category.tsx": "selling-category",
        "bounded-contexts/public-presence/routes/marketplace/help-article.tsx": "seller-answers",
      },
      paths: ["bounded-contexts/public-presence/features/help/"],
    },
    {
      id: "seller-policy-terms",
      version: 1,
      startPath: "/",
      role: "guest",
      host: "public-web",
      goal: "You plan to sell raw and graded cards here and want the rules in writing before you commit. Find the fee taken from each sale and whether a separate payment-processing fee applies, whether the seller agreement and the payments terms are in effect today or still awaiting review, and what the authenticity service terms cover. Do not contact anyone. Report any page that reads as a placeholder.",
      checks: ["sale-fee", "seller-agreement-status", "payments-terms-status", "authenticity-scope"],
      oracle: {
        "sale-fee":
          "Compare the reported sale fee and processing-fee treatment against the active commercial-terms fee schedule the sales-fees article resolves its values from.",
        "seller-agreement-status":
          "Compare the reported status against the seller agreement policy artifact's publication state, not the participant's paraphrase.",
        "payments-terms-status":
          "Compare the reported status against the payments terms policy artifact's publication state, not the participant's paraphrase.",
        "authenticity-scope": "Compare the reported coverage against the authenticity service terms artifact text.",
      },
      routes: {
        "bounded-contexts/commercial-terms/routes/public/sales-fees.tsx": "sale-fee",
        "bounded-contexts/public-presence/routes/marketplace/seller-agreement.tsx": "seller-agreement-status",
        "bounded-contexts/public-presence/routes/marketplace/payments-terms.tsx": "payments-terms-status",
        "bounded-contexts/public-presence/routes/marketplace/authenticity-terms.tsx": "authenticity-scope",
      },
      paths: ["bounded-contexts/public-presence/features/policies/", "bounded-contexts/commercial-terms/"],
    },
    {
      id: "site-terms-agents",
      version: 1,
      startPath: "/",
      role: "guest",
      host: "public-web",
      goal: "You want an AI assistant to browse and buy cards on your behalf. Find out whether the terms of service allow that, which additional rules apply to the assistant, and what personal data the privacy policy says the public site collects. Do not contact anyone.",
      checks: ["terms-agent-allowance", "agent-rules", "privacy-data"],
      oracle: {
        "terms-agent-allowance":
          "Compare the reported allowance against the automated-access subject in the terms of service artifact text.",
        "agent-rules": "Compare the reported rules against the agent connector terms artifact text.",
        "privacy-data":
          "Compare the reported data categories against the privacy policy artifact text, not the participant's paraphrase.",
      },
      routes: {
        "bounded-contexts/public-presence/routes/marketplace/terms.tsx": "terms-agent-allowance",
        "bounded-contexts/public-presence/routes/marketplace/agent-terms.tsx": "agent-rules",
        "bounded-contexts/public-presence/routes/marketplace/privacy.tsx": "privacy-data",
      },
      paths: ["bounded-contexts/public-presence/features/policies/"],
    },
    {
      id: "compare-marketplaces",
      version: 1,
      startPath: "/compare/ebay",
      role: "guest",
      host: "public-web",
      goal: "You sell trading cards on eBay today and are weighing a move. Work out what you would keep from a one hundred dollar card sale here compared with eBay, then find the same comparison against TCGplayer and report which of the two leaves a seller with less. Do not request early access.",
      checks: ["ebay-comparison", "tcgplayer-comparison"],
      oracle: {
        "ebay-comparison":
          "Recompute the kept amounts from the fee schedule the comparison page loads and the dated eBay figures it cites; compare against the participant's numbers.",
        "tcgplayer-comparison":
          "Recompute the kept amounts from the fee schedule the comparison page loads and the dated TCGplayer figures it cites; compare the participant's ranking of the two competitors.",
      },
      routes: {
        "bounded-contexts/public-presence/routes/marketplace/compare-ebay.tsx": "ebay-comparison",
        "bounded-contexts/public-presence/routes/marketplace/compare-tcgplayer.tsx": "tcgplayer-comparison",
      },
      paths: [
        "bounded-contexts/public-presence/features/waitlist/ui/compare-page",
        "bounded-contexts/commercial-terms/",
      ],
    },
    {
      id: "company-information",
      version: 1,
      startPath: "/",
      role: "guest",
      host: "public-web",
      goal: "You write a newsletter about card collecting and want to cover Chase Sets. Find how many founders the founders offer is limited to and how long their fee waiver lasts, the facts the company publishes for press and creators, and the email address for reaching the company. Do not send anything.",
      checks: ["founders-offer", "press-facts", "contact-address"],
      oracle: {
        "founders-offer":
          "Compare the reported founder cap and fee-waiver window against the founders offer terms artifact text.",
        "press-facts":
          "Compare the reported facts against the published creator and press fact sheet, including its live fee values.",
        "contact-address": "Compare the reported address against the contact page content.",
      },
      routes: {
        "bounded-contexts/public-presence/routes/marketplace/founders.tsx": "founders-offer",
        "bounded-contexts/public-presence/routes/marketplace/press.tsx": "press-facts",
        "bounded-contexts/public-presence/routes/marketplace/contact.tsx": "contact-address",
      },
      paths: [
        "bounded-contexts/public-presence/routes/marketplace/",
        "bounded-contexts/public-presence/features/policies/",
      ],
    },
    {
      id: "item-market-history",
      version: 1,
      startPath: "/",
      role: "guest",
      host: "marketplace",
      goal: "You own a raw, Near Mint, English Base Set Charizard and want to know what it would fetch. Find the lowest price currently asked for that exact version, whether any copies have sold recently, and if so the most recent sale price. Do not list, buy, make an offer, or save anything.",
      checks: ["search-results", "lowest-ask", "sales-history"],
      oracle: {
        "search-results":
          "Confirm from the recorded observations that the participant reached the seeded Charizard from marketplace search rather than a guessed address.",
        "lowest-ask":
          "Reobserve the lowest ask for the Raw, Near Mint product against the discovery market read model and the representative listings.",
        "sales-history":
          "Reobserve the recorded-sales state for that product against the discovery market-history read model; an empty history reported honestly is correct.",
      },
      routes: {
        "deployables/marketplace/app/routes/index.tsx": "search-results",
        "bounded-contexts/discovery/routes/search.tsx": "search-results",
        "bounded-contexts/discovery/routes/item-detail.tsx": "lowest-ask",
        "bounded-contexts/discovery/routes/item-detail-market-history.tsx": "sales-history",
      },
      paths: ["bounded-contexts/discovery/", "contracts/catalog-seed/representative-commerce-state.ts"],
    },
    {
      id: "set-browsing-filters",
      version: 1,
      startPath: "/sets/base-set",
      role: "guest",
      host: "marketplace",
      goal: "You collect the original 1999 Base Set and arrived at its card list. Find how many cards the set contains and when it was released, then find the Base Set cards currently listed for sale at fifty dollars or less and report their names with the lowest price for each. Do not buy, save, or watch anything.",
      checks: ["set-facts", "filtered-results"],
      oracle: {
        "set-facts":
          "Compare the reported card count and release date against the catalog reference-data seed for the Base Set expansion.",
        "filtered-results":
          "Reobserve the search results constrained to the Base Set with a fifty dollar maximum against the discovery search read model; compare names and lowest prices.",
      },
      routes: {
        "bounded-contexts/discovery/routes/set.tsx": "set-facts",
        "bounded-contexts/discovery/routes/search.tsx": "filtered-results",
      },
      paths: ["bounded-contexts/discovery/", "bounded-contexts/catalog/features/reference-data/"],
    },
    {
      id: "seller-profile-listing",
      version: 1,
      startPath: "/",
      role: "guest",
      host: "marketplace",
      goal: "You are about to buy a Base Set Charizard and want to vet the seller first. Find the seller offering the lowest-priced copy, then find where that seller ships from and what buyers have said about them, and open one more of that seller's current listings and report its price and available quantity. Do not buy, make an offer, or file a report about anyone.",
      checks: ["seller-profile", "listing-detail"],
      oracle: {
        "seller-profile":
          "Compare the reported ship-from location and feedback against the identity seed account and the marketplace reputation seed for that seller.",
        "listing-detail":
          "Reobserve the opened listing's price and available quantity against the discovery listing read model and the representative listings.",
      },
      routes: {
        "bounded-contexts/discovery/routes/public-account.tsx": "seller-profile",
        "bounded-contexts/discovery/routes/public-listing.tsx": "listing-detail",
      },
      paths: ["bounded-contexts/discovery/", "contracts/catalog-seed/representative-commerce-state.ts"],
    },
    {
      id: "public-market-page",
      version: 1,
      startPath: "/market/charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp",
      role: "guest",
      host: "public-web",
      goal: "You searched the web for Base Set Charizard prices and landed on this page. Report the most recent sale price, the thirty-day median, how many copies are listed right now, and the lowest listed price, saying plainly when a figure is not available. Do not create an alert, list, or buy.",
      checks: ["market-stats"],
      oracle: {
        "market-stats":
          "Compare every reported figure against the pricing public market page read model for the seeded Charizard; an unavailable figure reported as unavailable is correct.",
      },
      routes: {
        "bounded-contexts/pricing/routes/marketplace/market-price-history.tsx": "market-stats",
      },
      paths: [
        "bounded-contexts/pricing/features/public-market-pages/",
        "bounded-contexts/pricing/features/market-rollups/",
      ],
    },
    {
      id: "sign-in-options",
      version: 1,
      startPath: "/",
      role: "guest",
      host: "marketplace",
      startSignedIn: false,
      goal: "You already have an account but cannot remember your password and do not have your phone with you. Find the ways you could sign in and determine whether email alone is enough. Stop before entering any credential or requesting a link; do not sign in.",
      checks: ["sign-in-methods"],
      oracle: {
        "sign-in-methods":
          "Compare the reported methods against the marketplace auth host's configured sign-in methods; confirm from the recorded actions that no credential was entered and no link or code was requested.",
      },
      routes: {
        "bounded-contexts/auth/routes/marketplace/sign-in.tsx": "sign-in-methods",
      },
      paths: ["bounded-contexts/auth/features/sign-in/", "bounded-contexts/auth/routes/marketplace/sign-in"],
    },
    {
      id: "create-account",
      version: 1,
      startPath: "/",
      role: "guest",
      host: "marketplace",
      startSignedIn: false,
      goal: "You want your own account. Find out what you must provide to create one and whether you can do it without choosing a password. Stop at the account-creation screen without entering a password or submitting anything.",
      checks: ["registration-requirements"],
      oracle: {
        "registration-requirements":
          "Compare the reported requirements and the no-password option against the registration page's rendered fields; confirm from the recorded actions that nothing was submitted and no account exists for the session.",
      },
      routes: {
        "bounded-contexts/auth/routes/marketplace/register.tsx": "registration-requirements",
      },
      paths: ["bounded-contexts/auth/features/registration/", "bounded-contexts/auth/routes/marketplace/register"],
    },
    {
      id: "sign-out",
      version: 1,
      startPath: "/account",
      role: "guest",
      host: "marketplace",
      startSignedIn: true,
      goal: "You are signed in on a shared computer and are finished. Sign out, then confirm you are no longer signed in. Change nothing else.",
      checks: ["signed-out", "session-restored"],
      oracle: {
        "signed-out":
          "Confirm the session is ended in the auth session read model and a clean-route revisit of the account area shows the signed-out state.",
        "session-restored":
          "Confirm the moderator signs the same synthetic account back in before any other goal that starts signed in.",
      },
      routes: {
        "bounded-contexts/auth/routes/marketplace/sign-out.tsx": "signed-out",
      },
      paths: ["bounded-contexts/auth/support/route-support/", "bounded-contexts/auth/routes/marketplace/sign-out"],
      permits: "You may sign out of the synthetic account you start in.",
    },
  ],
  excludedRoutes: [
    { path: "bounded-contexts/public-presence/routes/marketplace/faq.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/public-presence/routes/marketplace/order-protection.tsx", reason: "redirect-only" },
    { path: "bounded-contexts/public-presence/routes/marketplace/refunds-and-returns.tsx", reason: "redirect-only" },
    {
      path: "bounded-contexts/public-presence/routes/developers/portal.tsx",
      reason:
        "fixture-gap: CHASE_SETS_M86_DEVELOPER_PORTAL_READY is unset in the bootstrap sandbox, so the route returns 404",
    },
    {
      path: "bounded-contexts/public-presence/routes/developers/article.tsx",
      reason:
        "fixture-gap: CHASE_SETS_M86_DEVELOPER_PORTAL_READY is unset in the bootstrap sandbox, so the route returns 404",
    },
    {
      path: "bounded-contexts/public-presence/routes/developers/llms.tsx",
      reason:
        "fixture-gap: CHASE_SETS_M86_DEVELOPER_PORTAL_READY is unset in the bootstrap sandbox, so the route returns 404",
    },
    {
      path: "bounded-contexts/public-presence/routes/developers/manifest.tsx",
      reason:
        "fixture-gap: CHASE_SETS_M86_DEVELOPER_PORTAL_READY is unset in the bootstrap sandbox, so the route returns 404",
    },
    {
      path: "bounded-contexts/auth/routes/marketplace/sign-in-magic.tsx",
      reason: "fixture-gap: no seeded magic-link token; without one the landing renders only its missing-link error",
    },
    {
      path: "bounded-contexts/auth/routes/marketplace/invite.tsx",
      reason: "fixture-gap: no seeded invitation id and acceptance token",
    },
    {
      path: "bounded-contexts/auth/routes/marketplace/guest-checkout-exit.tsx",
      reason: "fixture-gap: no seeded guest checkout session to exit from",
    },
    { path: "deployables/marketplace/app/routes/layout.tsx", reason: "layout-only" },
    { path: "deployables/marketplace/app/routes/not-found.tsx", reason: "error-page" },
    { path: "deployables/marketplace/app/routes/offline.tsx", reason: "error-page" },
    { path: "deployables/public-web/app/routes/not-found.tsx", reason: "error-page" },
  ],
};
