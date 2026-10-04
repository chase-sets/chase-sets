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
      host: "marketplace",
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
        "bounded-contexts/public-presence/routes/marketplace/refunds-and-returns.tsx": "return-shipping",
      },
      paths: ["bounded-contexts/public-presence/", "bounded-contexts/settlement/"],
      selectOnSharedChange: true,
    },
  ],
  excludedRoutes: [],
};
