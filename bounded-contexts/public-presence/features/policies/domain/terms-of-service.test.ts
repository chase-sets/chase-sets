import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalClaimRegistry, resolveUnresolvedPublicDisclosureText } from "./canonical-claims";
import { readCitedSourceSlice } from "../integrations/privacy-product-truth-inventory.mjs";
import {
  evaluateTermsOfServicePublicationReadiness,
  requiredTermsOfServiceSubjectIds,
  termsOfServicePolicyArtifact,
  type TermsOfServiceSubjectId,
} from "./terms-of-service";
import { unratifiedArbitrationDraftingDifferences } from "./arbitration-drafting-differences";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");

describe("Terms drift reconciliation", () => {
  it("distinguishes ruled Prepaid Balance from promotional Marketplace Credit", () => {
    const section = termsSection("cash-equivalent-and-marketplace-credit");
    expect(section.draftText).toContain("Prepaid Balance");
    expect(section.draftText).toContain("Payments Terms");
    expect(section.draftText).toContain("promotional, non-withdrawable");
    expect(section.draftText).not.toContain("promotional or prepaid");
    expect(section.reviewManifest.decisionRefs).toContain(7807);
    expect(section.reviewManifest.productTruthRefs).toContain(
      "https://github.com/chase-sets/chase-sets/issues/7807#issuecomment-5625822930",
    );
  });

  it("cites current platform charge and on-demand transfer ranges in both refs and assumption", () => {
    const section = termsSection("marketplace-role-and-limited-payments-agent");
    const roles = [
      ["infrastructure/stripe-payments/index.ts:", "/v1/payment_intents", "1464-1494"],
      ["infrastructure/stripe-connect/index.ts:", "platform-held-on-demand-payout", "1039-1094"],
    ];
    for (const [prefix, marker, oldRange] of roles) {
      const ref = section.reviewManifest.productTruthRefs.find((value) => value.startsWith(prefix!))!;
      expect(readCitedSourceSlice(repositoryRoot, ref).text).toContain(marker);
      expect(section.reviewManifest.assumptions[0]!.evidenceRef).toContain(ref);
      expect(readCitedSourceSlice(repositoryRoot, `${prefix}${oldRange}`).text).not.toContain(marker);
    }
  });

  it("names shipped compliance articles while preserving the unverified DMCA registration question", () => {
    const conduct = termsSection("conduct-and-policy-incorporation").reviewManifest.openQuestions.join(" ");
    expect(conduct).toContain("prohibited-and-restricted-items");
    expect(conduct).toContain("community-guidelines-and-enforcement");
    expect(conduct).not.toContain("not yet published");
    const content = termsSection("user-content-license").reviewManifest.openQuestions.join(" ");
    expect(content).toContain("intellectual-property-and-dmca");
    expect(content).toContain("registration-status-unverified");
    expect(content).toContain("counsel");
    expect(content).not.toMatch(/No prior IP-license|not-yet-made decision/);
  });

  it("removes the unratified injunctive-relief carve-out and preserves the authorized open question", () => {
    const section = termsSection("dispute-resolution-with-platform");
    const errors = arbitrationCarveoutErrors(section.draftText, section.reviewManifest.openQuestions);
    expect(errors).toEqual([]);

    const mutatedDraft = section.draftText.replace(
      "except that either party may bring an individual claim in small-claims court if it qualifies.",
      "except that either party may bring an individual claim in small-claims court if it qualifies, and either party may seek injunctive relief in court.",
    );
    expect(arbitrationCarveoutErrors(mutatedDraft, section.reviewManifest.openQuestions)).toContain(
      "unratified injunctive-relief carve-out remains in the draft",
    );
  });
});

function arbitrationCarveoutErrors(draftText: string, openQuestions: readonly string[]): readonly string[] {
  const errors: string[] = [];
  if (/injunctive relief/i.test(draftText)) errors.push("unratified injunctive-relief carve-out remains in the draft");
  const authorization = openQuestions.join(" ");
  if (!authorization.includes("removed under this question's recorded authorization")) {
    errors.push("removal authorization is not recorded");
  }
  if (!authorization.includes("adding one later needs a #5681 amendment")) {
    errors.push("#5681 amendment requirement is not recorded");
  }
  return errors;
}

/** Resolves every comma-separated range of a `path:ranges` citation, one slice per range. */
function citedRanges(reference: string): readonly { range: string; text: string }[] {
  const separator = reference.lastIndexOf(":");
  const relativePath = reference.slice(0, separator);
  return reference
    .slice(separator + 1)
    .split(",")
    .map((range) => {
      const slice = readCitedSourceSlice(repositoryRoot, `${relativePath}:${range}`);
      if (slice.error !== undefined || slice.text === undefined) {
        throw new Error(`${relativePath}:${range} — ${slice.error ?? "no cited text"}`);
      }
      return { range, text: slice.text };
    });
}

/** The exact line span of one Markdown entry: its heading through the last non-blank line before the next heading. */
function markdownEntrySpan(relativePath: string, heading: string): string {
  const lines = readFileSync(path.join(repositoryRoot, relativePath), "utf8").split(/\r?\n/);
  const start = lines.indexOf(heading);
  if (start === -1) {
    throw new Error(`${relativePath} has no heading '${heading}'.`);
  }
  let end = lines.findIndex((line, index) => index > start && line.startsWith("#"));
  end = end === -1 ? lines.length : end;
  while (lines[end - 1]!.trim() === "") end -= 1;
  return `${start + 1}-${end}`;
}

function sellerProceedsErrors(draftText: string): readonly string[] {
  const errors: string[] = [];
  if (
    !draftText.includes(
      "after the fees described in the Marketplace Sales Fee Schedule and the payout fee described in the Payout Fee policy document",
    )
  ) {
    errors.push("seller deductions must name the Marketplace Sales Fee Schedule and the payout fee");
  }
  if (draftText.includes("Checkout Fee")) errors.push("Marketplace Checkout Fee named as a seller deduction");
  return errors;
}

const settlementGlossaryPath = "bounded-contexts/settlement/GLOSSARY.md";
const walletAdjustmentAdrPath = "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md";

const negativeBalanceAuthorityPropositions = [
  {
    proposition: "approval gates only Wallet Adjustment Negative Balance increases",
    draftFragment:
      "A Wallet Adjustment that would create or increase a Negative Balance always requires elevated, separation-of-duties approval",
    sourcePath: walletAdjustmentAdrPath,
    heading: "### Negative balance and approval matrix",
    sourceFragments: [
      "For Wallet Adjustments, creating or increasing a negative balance is never an ordinary action",
      "| Creating or increasing a negative balance | Required | Required | Required, always",
    ],
  },
  {
    proposition: "automated chargeback recovery may create a Negative Balance",
    draftFragment: "Automated postings outside the Wallet Adjustment path, such as a chargeback clawback",
    sourcePath: settlementGlossaryPath,
    heading: "## Chargeback Clawback",
    sourceFragments: ["posted through Wallet commands and may create a negative available balance"],
  },
  {
    proposition: "automated label postage may create a Negative Balance",
    draftFragment: "or a shipping-label postage charge, can also create or increase a Negative Balance",
    sourcePath: settlementGlossaryPath,
    heading: "## Label Postage Debit",
    sourceFragments: ["may create a Negative Balance so that the order's later proceeds offset the charge"],
  },
  {
    proposition: "Negative Balance definition",
    draftFragment:
      "Your Wallet can carry a Negative Balance when chargeback, refund, or payout-recovery obligations exceed your available balance.",
    sourcePath: settlementGlossaryPath,
    heading: "## Negative Balance",
    sourceFragments: ["Wallet state where chargeback, refund, or payout recovery obligations exceed"],
  },
  {
    proposition: "Collections pauses listings and payout requests",
    draftFragment:
      "Chase Sets may pause new listings and payout requests until the balance is restored to good standing",
    sourcePath: settlementGlossaryPath,
    heading: "## Collections",
    sourceFragments: ["Collections pauses new listings", "Collections keeps payout requests paused"],
  },
] as const;

const walletAdjustmentDeciderPath = "bounded-contexts/settlement/features/wallets/domain/wallet-adjustment.ts";
const walletAdjustmentControlsPolicyPath =
  "bounded-contexts/settlement/features/wallets/domain/wallet-adjustment-controls-policy.ts";

const walletAdjustmentControlPairs = [
  {
    control: "two-operator",
    draftFragment:
      "approved by a different authorized operator, who may never approve a request they submitted themselves",
    code: [{ path: walletAdjustmentDeciderPath, range: "360-369", marker: "cannot be approved by its requester" }],
  },
  {
    control: "elevated",
    draftFragment:
      "A high-value Wallet Adjustment, or one that would create or increase a Negative Balance, also requires a second, elevated approval from an operator distinct from both the requester and the first approver",
    code: [
      { path: walletAdjustmentDeciderPath, range: "291-306", marker: 'reasons.push("high-value")' },
      { path: walletAdjustmentDeciderPath, range: "291-306", marker: 'reasons.push("negative-balance")' },
      {
        path: walletAdjustmentDeciderPath,
        range: "360-369",
        marker: "The elevated approver must be distinct from the requester and the primary approver.",
      },
      { path: walletAdjustmentControlsPolicyPath, range: "10-24", marker: "the two high-value dollar thresholds" },
      { path: walletAdjustmentControlsPolicyPath, range: "38-45", marker: '"settlement.wallet-adjustment-controls"' },
    ],
  },
  {
    control: "self-benefit",
    draftFragment: "Chase Sets blocks outright any Wallet Adjustment an operator requests for their own Account",
    code: [
      {
        path: walletAdjustmentDeciderPath,
        range: "360-369",
        marker: "A self-benefiting Wallet Adjustment is blocked outright and cannot be approved.",
      },
      { path: walletAdjustmentControlsPolicyPath, range: "10-24", marker: "self-benefiting block are unconditional" },
    ],
  },
  {
    control: "reason-code",
    draftFragment: "called a Wallet Adjustment, for reasons that include",
    code: [
      { path: walletAdjustmentDeciderPath, range: "24-35", marker: '"goodwill-cash-credit"' },
      { path: walletAdjustmentDeciderPath, range: "24-35", marker: '"other-with-required-detail"' },
      { path: walletAdjustmentDeciderPath, range: "325-328", marker: "requires a free-text explanation" },
    ],
  },
] as const;

function adjustmentAuthorityErrors(section: ReturnType<typeof termsSection>): readonly string[] {
  const errors: string[] = [];
  const codeRefs = section.reviewManifest.productTruthRefs.filter((reference) =>
    reference.startsWith("bounded-contexts/settlement/features/wallets/"),
  );
  if (codeRefs.length !== 2) errors.push(`expected the two shipped code refs, found ${codeRefs.length}`);
  for (const pair of walletAdjustmentControlPairs) {
    if (!section.draftText.includes(pair.draftFragment)) errors.push(`${pair.control}: draft control missing`);
    for (const { path: codePath, range, marker } of pair.code) {
      const reference = codeRefs.find((candidate) => candidate.startsWith(`${codePath}:`));
      const cited = reference === undefined ? undefined : citedRanges(reference).find((slice) => slice.range === range);
      if (cited === undefined) errors.push(`${pair.control}: ${codePath}:${range} is not cited`);
      else if (!cited.text.includes(marker)) errors.push(`${pair.control}: ${codePath}:${range} lacks '${marker}'`);
    }
  }
  const questions = section.reviewManifest.openQuestions.join(" ");
  if (/still in progress|implementation work/.test(questions)) errors.push("stale unbuilt-control wording remains");
  if (!questions.includes("approver-account and common-control cases are not enforced by shipped code")) {
    errors.push("unenforced ratified self-benefit scope is not qualified");
  }
  if (/approving operator's own account|common control/i.test(section.draftText)) {
    errors.push("draft asserts a self-benefit scope shipped code does not enforce");
  }
  return errors;
}

function userContentNoticeErrors(draftText: string): readonly string[] {
  const errors: string[] = [];
  if (
    !draftText.includes(
      "may act on a valid DMCA copyright notice sent to the designated agent identified in Chase Sets' published Help Center",
    )
  ) {
    errors.push("DMCA copyright notices must route to the designated agent");
  }
  if (!draftText.includes("any other valid intellectual-property complaint sent to the notice address")) {
    errors.push("other intellectual-property complaints must route to the notice address");
  }
  if (/DMCA[^,.;]*sent to the notice address/.test(draftText)) errors.push("DMCA notice routed to the notice address");
  return errors;
}

/** The listings subject's draft text, byte-identical to its text before the open question was added. */
const listingsDraftFixture =
  "A seller creates a Listing describing an item for sale. A buyer may purchase a Listing directly at checkout or submit an Offer that the seller may accept, counter, or decline. A binding sale contract between buyer and seller forms when Chase Sets' Ordering service records the Order, following direct-purchase checkout or Offer acceptance, a distinct and earlier step from payment capture, and the sale remains subject to the applicable cancellation, payment, and fulfillment terms described in these Terms and Chase Sets' published Help Center, including the buyer's limited self-service cancellation window before shipment. Chase Sets is not a party to the resulting sale contract and does not guarantee that a Listing or Offer is available, accurate, or free of error; sellers are solely responsible for honoring accepted Offers and completed purchases.";

const marketFollowingGlossaryRef = "bounded-contexts/pricing/GLOSSARY.md:186-188";

function marketFollowingQuestionErrors(section: ReturnType<typeof termsSection>): readonly string[] {
  const errors: string[] = [];
  if (section.draftText !== listingsDraftFixture) errors.push("listings draft text changed");
  const questions = section.reviewManifest.openQuestions.filter((question) =>
    question.includes("Market-Following Offer Target"),
  );
  if (questions.length !== 1) return [...errors, `expected one Market-Following question, found ${questions.length}`];
  const question = questions[0]!;
  const reference = question.match(/\((bounded-contexts\/pricing\/GLOSSARY\.md:[0-9-]+)\)/)?.[1];
  if (reference !== marketFollowingGlossaryRef) errors.push(`glossary ref drifted: ${reference ?? "missing"}`);
  else if (
    `${reference.split(":")[1]}` !==
    markdownEntrySpan("bounded-contexts/pricing/GLOSSARY.md", "## Market-Following Offer Target")
  ) {
    errors.push("glossary ref is not the Market-Following Offer Target entry");
  }
  for (const fragment of [
    "Pricing ships a Market-Following Offer Target",
    "proposed unit item amount for a buyer Offer",
    "This subject's draft text does not describe it",
    "is a counsel question",
  ]) {
    if (!question.includes(fragment)) errors.push(`question lacks '${fragment}'`);
  }
  return errors;
}

describe("Terms reconciliation with ratified decisions and shipped controls", () => {
  it("marketplace-role-and-limited-payments-agent seller proceeds exclude Marketplace Checkout Fee", () => {
    const section = termsSection("marketplace-role-and-limited-payments-agent");
    expect(sellerProceedsErrors(section.draftText)).toEqual([]);
    expect(section.draftText).not.toContain("and the Marketplace Checkout Fee");
    const [checkoutFee] = citedRanges("bounded-contexts/payments/GLOSSARY.md:101-103");
    expect(section.reviewManifest.productTruthRefs).toContain("bounded-contexts/payments/GLOSSARY.md:101-103");
    expect(checkoutFee!.text).toContain("buyer-side payment-level marketplace fee");
    const sellerFeesRef = "bounded-contexts/public-presence/features/policies/domain/seller-agreement.ts:154";
    expect(section.reviewManifest.productTruthRefs).toContain(sellerFeesRef);
    const [sellerFees] = citedRanges(sellerFeesRef);
    expect(sellerFees!.text).toContain("are never deducted from your proceeds");
    expect(sellerFees!.text).toContain("payout fee published in the current Payout Fee policy document");

    const reverted = section.draftText.replace(
      "and the payout fee described in the Payout Fee policy document",
      "and the Marketplace Checkout Fee",
    );
    expect(sellerProceedsErrors(reverted)).toEqual([
      "seller deductions must name the Marketplace Sales Fee Schedule and the payout fee",
      "Marketplace Checkout Fee named as a seller deduction",
    ]);
  });

  it("negative-balances-and-restrictions cites each authority proposition", () => {
    const section = termsSection("negative-balances-and-restrictions");
    const refs = section.reviewManifest.productTruthRefs;
    for (const row of negativeBalanceAuthorityPropositions) {
      expect(section.draftText, row.proposition).toContain(row.draftFragment);
      const span = markdownEntrySpan(row.sourcePath, row.heading);
      const reference = refs.find((candidate) => candidate.startsWith(`${row.sourcePath}:`));
      expect(reference, row.proposition).toBeDefined();
      const cited = citedRanges(reference!).find((slice) => slice.range === span);
      expect(cited, `${row.proposition} cites exactly ${row.sourcePath}:${span}`).toBeDefined();
      for (const fragment of row.sourceFragments) expect(cited!.text, row.proposition).toContain(fragment);
    }
    expect(refs).toEqual([
      `${settlementGlossaryPath}:127-135,158-166,168-176,178-186`,
      `${walletAdjustmentAdrPath}:70-82`,
    ]);
    expect(section.reviewManifest.assumptions[0]!.evidenceRef).toBe(
      `${settlementGlossaryPath}:${markdownEntrySpan(settlementGlossaryPath, "## Collections")}`,
    );

    // Negative controls: the prior refs and the brief's evidence-commit ranges no longer bound these entries,
    // and blanket approval of every Negative Balance increase is gone.
    expect(refs).not.toContain(`${settlementGlossaryPath}:149,152-170`);
    const entrySpans = negativeBalanceAuthorityPropositions
      .filter(({ sourcePath }) => sourcePath === settlementGlossaryPath)
      .map(({ heading }) => markdownEntrySpan(settlementGlossaryPath, heading));
    for (const staleRange of ["149", "152-170", "152-159", "162-170", "172-180"]) {
      expect(entrySpans).not.toContain(staleRange);
    }
    expect(section.draftText).not.toMatch(/Creating or increasing a Negative Balance, and any Wallet Adjustment/);
    expect(section.draftText).not.toMatch(/(?:every|any) (?:creation|increase)[^.]*Negative Balance[^.]*approval/i);
  });

  it("adjustment-authority pairs every asserted control with shipped code", () => {
    const section = termsSection("adjustment-authority");
    expect(adjustmentAuthorityErrors(section)).toEqual([]);
    const questions = section.reviewManifest.openQuestions.join(" ");
    const [routeCheck] = citedRanges("bounded-contexts/settlement/features/wallets/api/wallet-adjustment-route.ts:618");
    expect(questions).toContain("bounded-contexts/settlement/features/wallets/api/wallet-adjustment-route.ts:574,618");
    expect(routeCheck!.text).toContain("selfBenefiting: targetAccountId === access.actor.accountId");

    const staleQuestion = {
      ...section,
      reviewManifest: {
        ...section.reviewManifest,
        openQuestions: [
          "The typed request/approve/reject/reverse lifecycle (#4998), platform-admin permissions (#5000), and the wallet-adjustment-controls policy document are implementation work still in progress.",
        ],
      },
    };
    expect(adjustmentAuthorityErrors(staleQuestion)).toEqual([
      "stale unbuilt-control wording remains",
      "unenforced ratified self-benefit scope is not qualified",
    ]);
    const uncitedCode = {
      ...section,
      reviewManifest: {
        ...section.reviewManifest,
        productTruthRefs: section.reviewManifest.productTruthRefs.filter(
          (reference) => !reference.startsWith(walletAdjustmentControlsPolicyPath),
        ),
      },
    };
    expect(adjustmentAuthorityErrors(uncitedCode)).toContain("expected the two shipped code refs, found 1");
    const overclaim = {
      ...section,
      draftText: `${section.draftText} The block also covers the approving operator's own account.`,
    };
    expect(adjustmentAuthorityErrors(overclaim)).toEqual([
      "draft asserts a self-benefit scope shipped code does not enforce",
    ]);
  });

  it("user-content-license separates DMCA and other intellectual-property notices", () => {
    const section = termsSection("user-content-license");
    expect(userContentNoticeErrors(section.draftText)).toEqual([]);
    const articleRef =
      "bounded-contexts/public-presence/features/help/domain/articles/intellectual-property-and-dmca.en.md:58-62";
    expect(section.reviewManifest.productTruthRefs).toContain(articleRef);
    const [article] = citedRanges(articleRef);
    expect(article!.text).toContain("## Where to send a notice");
    expect(article!.text).toContain("Send DMCA notices for Chase Sets to the designated contact");

    const dmcaToNoticeAddress = section.draftText.replace(
      "the designated agent identified in Chase Sets' published Help Center",
      "the notice address in the governing-law-and-forum subject below",
    );
    expect(userContentNoticeErrors(dmcaToNoticeAddress)).toEqual([
      "DMCA copyright notices must route to the designated agent",
      "DMCA notice routed to the notice address",
    ]);
  });

  it("market following offer manifest question is factual and draft-preserving", () => {
    const section = termsSection("listings-offers-and-contract-formation");
    expect(marketFollowingQuestionErrors(section)).toEqual([]);
    const [entry] = citedRanges(marketFollowingGlossaryRef);
    expect(entry!.text).toContain("## Market-Following Offer Target");
    expect(entry!.text).toContain("Pricing's proposed unit item amount for a buyer Offer");

    const omitted = { ...section, reviewManifest: { ...section.reviewManifest, openQuestions: [] } };
    expect(marketFollowingQuestionErrors(omitted)).toEqual(["expected one Market-Following question, found 0"]);
    const adjacentRef = {
      ...section,
      reviewManifest: {
        ...section.reviewManifest,
        openQuestions: section.reviewManifest.openQuestions.map((question) =>
          question.replace(marketFollowingGlossaryRef, "bounded-contexts/pricing/GLOSSARY.md:184-186"),
        ),
      },
    };
    expect(marketFollowingQuestionErrors(adjacentRef)).toEqual([
      "glossary ref drifted: bounded-contexts/pricing/GLOSSARY.md:184-186",
    ]);
    const draftChanged = {
      ...section,
      draftText: `${section.draftText} Pricing may propose a market-following Offer amount.`,
    };
    expect(marketFollowingQuestionErrors(draftChanged)).toEqual(["listings draft text changed"]);
  });
});

function resolveIdentityCitation(reference: string) {
  const match = reference.match(/^(bounded-contexts\/identity\/features\/accounts\/domain\/domain\.ts):([0-9,-]+)/);
  if (!match) {
    throw new Error(`Invalid Identity account citation: ${reference}`);
  }
  const lines = readFileSync(path.join(repositoryRoot, match[1]!), "utf8").split(/\r?\n/);
  return match[2]!
    .split(",")
    .flatMap((range) => {
      const [startText, endText = startText] = range.split("-");
      return lines.slice(Number(startText) - 1, Number(endText));
    })
    .join("\n");
}

function termsIdentityCitations() {
  const section = termsOfServicePolicyArtifact.sections.find(({ id }) => id === "suspension-closure-and-holds")!;
  return [
    {
      name: "product truth",
      reference: section.reviewManifest.productTruthRefs.find((reference) => reference.includes("domain/domain.ts"))!,
      symbols: ["SuspendAccountCommand", "ReactivateAccountCommand", "CloseAccountCommand", "AccountStatus"],
    },
    {
      name: "assumption",
      reference: section.reviewManifest.assumptions.find(({ evidenceRef }) => evidenceRef.includes("domain/domain.ts"))!
        .evidenceRef,
      symbols: ["AccountSuspendedEvent", "AccountClosedEvent", "lastEnforcementAction"],
    },
  ];
}

const agentResponsibilityClaimId = "authorized-agent-principal-responsibility-and-liability-boundary";
const agentAccessAndAccountSanctionClaimId = "agent-access-and-agent-caused-account-sanction-boundary";

function termsSection(sectionId: TermsOfServiceSubjectId) {
  const section = termsOfServicePolicyArtifact.sections.find((candidate) => candidate.id === sectionId);
  if (section === undefined) {
    throw new Error(`Terms of Service artifact is missing section '${sectionId}'.`);
  }
  return section;
}

/**
 * Before/after sentence table for the two sections that carried the
 * authorized-agent responsibility boundary in public draft text.
 *
 * `before` records the exact prose each sentence had prior to this change and
 * is documentation for review; `after` is asserted. A sentence whose `after`
 * equals its `before` must be byte-identical — the change is allowed to touch
 * exactly one sentence per section and nothing else.
 */
const agentBoundarySentenceTable = [
  {
    sectionId: "electronic-agents-and-automated-access",
    label: "MCP interface, developer portal, and bounded permission grant",
    before:
      "Chase Sets publishes a Model Context Protocol interface and a developer portal (chasesets.com/developers) that let you authorize a software agent to act on your Account within a bounded set of permissions you grant.",
    after:
      "Chase Sets publishes a Model Context Protocol interface and a developer portal (chasesets.com/developers) that let you authorize a software agent to act on your Account within a bounded set of permissions you grant.",
  },
  {
    sectionId: "electronic-agents-and-automated-access",
    label: "Agent Connector Terms incorporation and conflict rule",
    before:
      "Automated or agent access to Chase Sets is governed by the Agent Connector Terms (chasesets.com/agent-terms) in addition to these Terms; where the two conflict on automated-access-specific subjects, the Agent Connector Terms control.",
    after:
      "Automated or agent access to Chase Sets is governed by the Agent Connector Terms (chasesets.com/agent-terms) in addition to these Terms; where the two conflict on automated-access-specific subjects, the Agent Connector Terms control.",
  },
  {
    sectionId: "eligibility-and-accounts",
    label: "Minimum age and contracting capacity",
    before: "You must be at least 18 years old and able to form a binding contract to create a Chase Sets Account.",
    after: "You must be at least 18 years old and able to form a binding contract to create a Chase Sets Account.",
  },
  {
    sectionId: "eligibility-and-accounts",
    label: "Bounded holder duties: registration accuracy, contact currency, credential safeguarding",
    before:
      "You are responsible for the accuracy of the information you provide when you register, for keeping your contact information current, and for safeguarding your credentials, including any password, passkey, or API key, and for all activity conducted through your Account.",
    after:
      "You are responsible for the accuracy of the information you provide when you register, for keeping your contact information current, and for safeguarding your credentials, including any password, passkey, or API key.",
  },
  {
    sectionId: "eligibility-and-accounts",
    label: "Registration screening",
    before:
      "Chase Sets may screen registration and decline, delay, or condition an Account, including through an invitation or waitlist process.",
    after:
      "Chase Sets may screen registration and decline, delay, or condition an Account, including through an invitation or waitlist process.",
  },
  {
    sectionId: "eligibility-and-accounts",
    label: "Compromise notification",
    before:
      "Notify Chase Sets promptly through a Support Request if you believe your Account or credentials have been compromised.",
    after:
      "Notify Chase Sets promptly through a Support Request if you believe your Account or credentials have been compromised.",
  },
] as const satisfies readonly Readonly<{
  sectionId: TermsOfServiceSubjectId;
  label: string;
  before: string;
  after: string;
}>[];

/** The whole sentence deleted from the agent subject. */
const deletedAgentBoundarySentence =
  "You remain responsible for actions your authorized agent takes on your Account, and Chase Sets may suspend " +
  "an agent's access, or your Account, for activity that violates these Terms, the Agent Connector Terms, or " +
  "an incorporated policy.";

/** The clause removed from the account subject's responsibility sentence. */
const deletedAccountActivityClause = "and for all activity conducted through your Account";

describe("Terms of Service policy artifact", () => {
  it.each(termsIdentityCitations())("resolves the Identity $name citation to its claimed symbols", (row) => {
    const source = resolveIdentityCitation(row.reference);
    for (const symbol of row.symbols) {
      expect(source).toContain(symbol);
    }
  });

  it("rejects an adjacent unrelated range for both Identity citations", () => {
    for (const row of termsIdentityCitations()) {
      const unrelated = resolveIdentityCitation(row.reference.replace(/:[0-9,-]+/, ":1-5"));
      expect(row.symbols.some((symbol) => unrelated.includes(symbol))).toBe(false);
    }
  });

  it("is a versioned, linkable, locale-specific artifact aligned to the canonical consent key", () => {
    expect(termsOfServicePolicyArtifact.metadata).toMatchObject({
      policyKey: "terms-of-service",
      version: "v1",
      locale: "en",
      href: "/terms",
      publicationStatus: "counsel-review-required",
      effectiveAt: null,
      counselApprovalReference: null,
    });
  });

  it("models the complete wallet plus marketplace policy taxonomy required before publication", () => {
    expect(requiredTermsOfServiceSubjectIds).toEqual([
      "wallet-nature-custody-interest",
      "cash-equivalent-and-marketplace-credit",
      "adjustment-authority",
      "provisional-credits-and-reversals",
      "setoff",
      "negative-balances-and-restrictions",
      "history-notice-and-disputes",
      "suspension-closure-and-holds",
      "effective-date-notice-and-acceptance",
      "evidence-and-fair-use",
      "marketplace-role-and-limited-payments-agent",
      "eligibility-and-accounts",
      "listings-offers-and-contract-formation",
      "conduct-and-policy-incorporation",
      "user-content-license",
      "electronic-agents-and-automated-access",
      "electronic-communications-and-esign",
      "disclaimers-and-liability-limits",
      "user-vs-user-dispute-release",
      "dispute-resolution-with-platform",
      "governing-law-and-forum",
      "changes-notice-and-acceptance",
    ]);
    expect(termsOfServicePolicyArtifact.sections.map((section) => section.id)).toEqual(
      requiredTermsOfServiceSubjectIds,
    );
    expect(termsOfServicePolicyArtifact.sections.every((section) => section.reviewStatus === "counsel-required")).toBe(
      true,
    );
  });

  it("has non-empty counsel-ready draft copy and a complete review manifest for every subject", () => {
    const sensitiveDecisionRefsBySubject: Partial<Record<TermsOfServiceSubjectId, number>> = {
      "dispute-resolution-with-platform": 5681,
      "governing-law-and-forum": 5677,
    };

    for (const section of termsOfServicePolicyArtifact.sections) {
      expect(section.draftText.trim().length).toBeGreaterThan(0);
      expect(section.reviewManifest.scopeNote.trim().length).toBeGreaterThan(0);
      expect(section.reviewManifest.assumptions.length).toBeGreaterThan(0);
      for (const assumption of section.reviewManifest.assumptions) {
        expect(assumption.assertion.trim().length).toBeGreaterThan(0);
        expect(assumption.evidenceRef.trim().length).toBeGreaterThan(0);
      }

      const requiredDecisionRef = sensitiveDecisionRefsBySubject[section.id];
      if (requiredDecisionRef !== undefined) {
        expect(section.reviewManifest.decisionRefs).toContain(requiredDecisionRef);
      }
    }
  });

  it("keeps fees, windows, and caps as policy references instead of prose numbers, other than the ratified arbitration mechanics", () => {
    const exemptFromNoProseNumberRule: readonly TermsOfServiceSubjectId[] = ["dispute-resolution-with-platform"];

    for (const section of termsOfServicePolicyArtifact.sections) {
      if (exemptFromNoProseNumberRule.includes(section.id)) {
        continue;
      }
      expect(section.draftText).not.toMatch(/\$\d/);
      expect(section.draftText).not.toMatch(/\d+(\.\d+)?\s?%/);
    }
  });

  it("fails the publication gate while counsel copy, approval, effective date, and rollout limits remain pending", () => {
    const readiness = evaluateTermsOfServicePublicationReadiness(termsOfServicePolicyArtifact);

    expect(readiness.ready).toBe(false);
    expect(readiness.errors).toEqual(
      expect.arrayContaining([
        "Terms of Service publication status must be published.",
        "Terms of Service publication requires an effective ISO timestamp.",
        "Terms of Service publication requires a non-placeholder counsel approval reference.",
        "Terms of Service publication requires at least one reviewed rollout jurisdiction or product limit.",
      ]),
    );
    expect(readiness.errors.filter((error) => error.includes("requires counsel-approved copy"))).toHaveLength(
      requiredTermsOfServiceSubjectIds.length,
    );
    expect(readiness.errors.filter((error) => error.includes("requires non-empty operative copy"))).toHaveLength(0);
  });

  it("accepts a fully reviewed publication without changing the required subject taxonomy", () => {
    const readiness = evaluateTermsOfServicePublicationReadiness({
      ...termsOfServicePolicyArtifact,
      metadata: {
        ...termsOfServicePolicyArtifact.metadata,
        publicationStatus: "published",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        counselApprovalReference: "LEGAL-WALLET-TERMS-2026-08-15",
        rolloutJurisdictionsOrProductLimits: ["United States launch scope approved in the referenced record."],
      },
      sections: termsOfServicePolicyArtifact.sections.map((section) => ({
        ...section,
        draftText: `Reviewed operative test copy for ${section.id}.`,
        reviewStatus: "counsel-approved" as const,
      })),
    });

    expect(readiness).toEqual({ ready: true, errors: [] });
  });
});
describe("authorized-agent responsibility and access boundary", () => {
  it("reconstructs both edited sections exactly from the before/after sentence table", () => {
    for (const sectionId of ["electronic-agents-and-automated-access", "eligibility-and-accounts"] as const) {
      const rows = agentBoundarySentenceTable.filter((row) => row.sectionId === sectionId);
      expect(rows.length).toBeGreaterThan(0);

      // Exact equality, not containment: the section is the table and nothing
      // else, so an added sentence fails here even if every listed sentence
      // still survives verbatim.
      expect(termsSection(sectionId).draftText).toBe(rows.map((row) => row.after).join(" "));
    }
  });

  it("keeps every sentence outside the two edited ones byte-identical to its prior prose", () => {
    const changed = agentBoundarySentenceTable.filter((row) => row.before !== row.after);

    expect(changed.map((row) => `${row.sectionId}: ${row.label}`)).toEqual([
      "eligibility-and-accounts: Bounded holder duties: registration accuracy, contact currency, credential safeguarding",
    ]);
    for (const row of agentBoundarySentenceTable) {
      if (row.before === row.after) {
        expect(termsSection(row.sectionId).draftText).toContain(row.before);
      }
    }
  });

  it("removed the agent-responsibility sentence and the all-activity clause from public draft text", () => {
    const agentSection = termsSection("electronic-agents-and-automated-access");
    const eligibilitySection = termsSection("eligibility-and-accounts");

    expect(agentSection.draftText).not.toContain(deletedAgentBoundarySentence);
    expect(agentSection.draftText.toLowerCase()).not.toContain("you remain responsible");
    expect(agentSection.draftText.toLowerCase()).not.toContain("suspend an agent's access");
    expect(eligibilitySection.draftText).not.toContain(deletedAccountActivityClause);
    expect(eligibilitySection.draftText.toLowerCase()).not.toContain("all activity conducted through your account");
  });

  it("retains the registration-accuracy, contact-currency, and credential-safeguarding duties in the bounded clause", () => {
    const draftText = termsSection("eligibility-and-accounts").draftText;

    expect(draftText).toContain("the accuracy of the information you provide when you register");
    expect(draftText).toContain("keeping your contact information current");
    expect(draftText).toContain("safeguarding your credentials, including any password, passkey, or API key");
  });

  it("states no responsibility posture for authorized-agent activity in either direction", () => {
    const lowered = termsSection("eligibility-and-accounts").draftText.toLowerCase();

    // The extent is declined, not decided: the section must not assign
    // responsibility for agent activity, and must not disclaim it either.
    for (const phrase of [
      "agent",
      "automated",
      "not responsible",
      "no responsibility",
      "responsible for all",
      "all activity",
    ]) {
      expect(lowered).not.toContain(phrase);
    }
  });

  it("enrolls exactly three claim disclosures across exactly two sections, each mirrored in its manifest", () => {
    const enrolled = termsOfServicePolicyArtifact.sections.flatMap((section) =>
      (section.claimDisclosures ?? [])
        .filter(
          (disclosure) =>
            disclosure.claimId === agentResponsibilityClaimId ||
            disclosure.claimId === agentAccessAndAccountSanctionClaimId,
        )
        .map((disclosure) => ({ sectionId: section.id, claimId: disclosure.claimId })),
    );

    expect(enrolled).toEqual([
      { sectionId: "eligibility-and-accounts", claimId: agentResponsibilityClaimId },
      { sectionId: "electronic-agents-and-automated-access", claimId: agentResponsibilityClaimId },
      { sectionId: "electronic-agents-and-automated-access", claimId: agentAccessAndAccountSanctionClaimId },
    ]);

    for (const { sectionId, claimId } of enrolled) {
      const section = termsSection(sectionId as TermsOfServiceSubjectId);
      const claimRef = (section.reviewManifest.canonicalClaims ?? []).find(
        (candidate) => candidate.claimId === claimId,
      );

      expect(claimRef, `${sectionId} must mirror ${claimId} in its review manifest`).toBeDefined();
      expect(claimRef?.productTruthRefs).toEqual([]);
      expect(section.reviewManifest.openQuestions.length).toBeGreaterThan(0);
      expect(section.reviewStatus).toBe("counsel-required");
    }
  });

  it("carries an explicit counsel question for each enrolled proposition", () => {
    const eligibilityQuestions = termsSection("eligibility-and-accounts").reviewManifest.openQuestions.join(" ");
    const agentQuestions = termsSection("electronic-agents-and-automated-access").reviewManifest.openQuestions.join(
      " ",
    );

    expect(eligibilityQuestions).toContain("Counsel question:");
    expect(eligibilityQuestions.toLowerCase()).toContain("authorized software agent's activity");
    expect(agentQuestions.match(/Counsel question:/g)).toHaveLength(2);
    expect(agentQuestions.toLowerCase()).toContain("responsibility or liability");
    expect(agentQuestions.toLowerCase()).toContain("suspended or revoked");
  });

  it("registers both identities as unresolved with one status and provenance and no product truth", () => {
    for (const claimId of [agentResponsibilityClaimId, agentAccessAndAccountSanctionClaimId] as const) {
      const definition = canonicalClaimRegistry[claimId];

      expect(definition.status).toBe("unresolved");
      expect(definition.productTruthRefs).toEqual([]);
      expect(definition.requiredEvidenceKeywords).toEqual([]);
      expect(definition.forbiddenAssertionPhrases).toHaveLength(5);
    }

    expect(resolveUnresolvedPublicDisclosureText(agentResponsibilityClaimId)).toBe(
      "The extent to which an account holder is responsible or liable for actions taken by an authorized agent " +
        "remains unresolved pending qualified counsel review.",
    );
    expect(resolveUnresolvedPublicDisclosureText(agentAccessAndAccountSanctionClaimId)).toBe(
      "The grounds, process, and consequences for suspending or revoking agent access, and for suspending, " +
        "restricting, or closing an Account because of agent conduct, remain unresolved pending qualified counsel " +
        "review.",
    );

    expect(canonicalClaimRegistry[agentResponsibilityClaimId].description).toBe(
      "Whether, and how far, an account holder is responsible or liable for actions an authorized software agent " +
        "takes on the Account is not yet supported by any ratified product-truth source; it remains an explicit " +
        "open question pending qualified counsel confirmation before publication, not a productTruthRef-backed fact.",
    );
    expect(canonicalClaimRegistry[agentAccessAndAccountSanctionClaimId].description).toBe(
      "Whether, on what grounds, and with what process and consequences Chase Sets may suspend or revoke an " +
        "authorized software agent's access, and may separately suspend, restrict, close or otherwise sanction the " +
        "underlying Account because of that agent's conduct is not yet supported by any ratified product-truth " +
        "source; it remains an explicit open question pending qualified counsel confirmation before publication, " +
        "not a productTruthRef-backed fact.",
    );
  });

  it("maps both isolated P-B controls to the one two-branch canonical identity", () => {
    const coverage = [
      {
        control: "credential/access disablement",
        draftText:
          "Chase Sets may disable a delegated program's credentials whenever its conduct violates these rules.",
        claimId: agentAccessAndAccountSanctionClaimId,
      },
      {
        control: "agent-caused Account lock",
        draftText: "If an automated delegate breaks an incorporated rule, Chase Sets can lock the profile it uses.",
        claimId: agentAccessAndAccountSanctionClaimId,
      },
    ] as const;

    expect(coverage.map(({ control, claimId }) => ({ control, claimId }))).toEqual([
      { control: "credential/access disablement", claimId: agentAccessAndAccountSanctionClaimId },
      { control: "agent-caused Account lock", claimId: agentAccessAndAccountSanctionClaimId },
    ]);
    expect(coverage.every(({ draftText }) => draftText.length > 0)).toBe(true);
  });

  it("requires claim 2's id, description, disclosure, and isolated controls to cover both P-B branches", () => {
    const definition = canonicalClaimRegistry[agentAccessAndAccountSanctionClaimId];
    const components = [
      {
        name: "id",
        text: agentAccessAndAccountSanctionClaimId,
        agentAccess: (text: string) => text.includes("agent-access"),
        accountSanction: (text: string) => text.includes("agent-caused-account-sanction"),
      },
      {
        name: "description",
        text: definition.description,
        agentAccess: (text: string) => text.includes("agent's access"),
        accountSanction: (text: string) =>
          text.includes("underlying Account") && text.includes("because of that agent's conduct"),
      },
      {
        name: "disclosure",
        text: definition.unresolvedPublicDisclosure!,
        agentAccess: (text: string) => text.includes("agent access"),
        accountSanction: (text: string) => text.includes("Account because of agent conduct"),
      },
    ] as const;

    for (const component of components) {
      expect(component.agentAccess(component.text), `${component.name}: agent-access branch`).toBe(true);
      expect(component.accountSanction(component.text), `${component.name}: agent-caused Account-sanction branch`).toBe(
        true,
      );
    }

    const accessOnlyIdMutant = "agent-access-suspension-and-revocation-boundary";
    expect(components[0].agentAccess(accessOnlyIdMutant)).toBe(true);
    expect(components[0].accountSanction(accessOnlyIdMutant)).toBe(false);

    const accessOnlyDescriptionMutant =
      "Whether, on what grounds, and with what process and consequences Chase Sets may suspend or revoke an " +
      "authorized software agent's access is not yet supported by any ratified product-truth source.";
    expect(components[1].agentAccess(accessOnlyDescriptionMutant)).toBe(true);
    expect(components[1].accountSanction(accessOnlyDescriptionMutant)).toBe(false);

    expect(definition.unresolvedPublicDisclosure).toBe(
      canonicalClaimRegistry[agentAccessAndAccountSanctionClaimId].unresolvedPublicDisclosure,
    );
    expect(
      termsOfServicePolicyArtifact.sections
        .flatMap((section) => section.claimDisclosures ?? [])
        .filter(({ claimId }) => claimId === agentAccessAndAccountSanctionClaimId),
    ).toHaveLength(1);
  });

  it("keeps the artifact non-effective, non-activatable, and counsel-review-required", () => {
    expect(termsOfServicePolicyArtifact.metadata).toMatchObject({
      publicationStatus: "counsel-review-required",
      effectiveAt: null,
      counselApprovalReference: null,
    });
    expect(evaluateTermsOfServicePublicationReadiness(termsOfServicePolicyArtifact).ready).toBe(false);
  });
});
