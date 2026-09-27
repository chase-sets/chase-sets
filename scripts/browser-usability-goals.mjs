export const browserUsabilityGoals = [
  {
    id: "find-card",
    version: 1,
    startPath: "/",
    role: "buyer",
    goal: "Find an English Base Set Charizard, raw and Near Mint. Determine whether you can buy that variant now and at what price. Do not add it to a cart or buy it. Report unavailable information rather than guessing.",
    checks: ["variant", "availability-and-price"],
    paths: ["bounded-contexts/discovery/", "bounded-contexts/catalog/"],
  },
  {
    id: "seller-away",
    version: 1,
    startPath: "/account",
    role: "seller",
    goal: "Schedule time away for the future dates supplied in your fixture task context, with automatic return. Then leave that area and come back to confirm the schedule. Change only this synthetic account's away window, not listings or prices.",
    checks: ["scheduled-dates", "canonical-state", "clean-route-readback", "fixture-restored"],
    paths: ["bounded-contexts/marketplace/features/listings/", "bounded-contexts/marketplace/routes/account-listings"],
  },
  {
    id: "buyer-shipment",
    version: 1,
    startPath: "/account",
    role: "buyer",
    goal: "Find the Twilight Masquerade Elite Trainer Box shipment with tracking reference 1ZSEEDREVIEWELIGIBLE. Determine whether and when it was delivered, and reach the place to report a problem for the correct purchase. Do not submit a report, send a message, review, or buy anything.",
    checks: ["shipment-identity", "delivery-status-and-time", "problem-entry"],
    paths: ["bounded-contexts/fulfillment/", "bounded-contexts/ordering/", "bounded-contexts/platform-operations/"],
  },
  {
    id: "condition-policy",
    version: 1,
    startPath: "/help",
    role: "guest",
    goal: "A card arrived in worse condition than its listing. Find where to report it, the reporting deadline after delivery, and who pays return shipping. Do not open a case or contact anyone. Explain any uncertainty or inconsistent guidance.",
    checks: ["report-location", "deadline", "return-shipping"],
    paths: ["bounded-contexts/public-presence/", "bounded-contexts/settlement/"],
  },
];

export function selectBrowserUsabilityGoals(paths) {
  const shared =
    /^(packages\/design-system\/|contracts\/localization\/|bounded-contexts\/auth\/|bounded-contexts\/identity\/|deployables\/(marketplace|public-web)\/|scripts\/browser-usability)/;
  return browserUsabilityGoals.filter((goal) =>
    paths.some((file) => shared.test(file) || goal.paths.some((prefix) => file.startsWith(prefix))),
  );
}

export function browserUsabilityGoal(id) {
  const goal = browserUsabilityGoals.find((entry) => entry.id === id);
  if (!goal) throw new Error(`Unknown browser usability goal: ${id}`);
  return goal;
}
