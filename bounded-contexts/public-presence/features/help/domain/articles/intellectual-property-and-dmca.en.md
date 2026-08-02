---
slug: intellectual-property-and-dmca
title: "Intellectual property and DMCA"
description: How Chase Sets handles copyright and other intellectual-property complaints, how to send a DMCA notice or counter-notice, where to send it, and how repeat infringement affects an account.
audience: seller
category: selling
reviewedAt: "2026-08-02"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: Listings reported for counterfeit concerns or stolen photos enter the recorded Trust & Safety moderation queue, and an active listing auto-unlists when the distinct-reporter threshold is reached.
    issues: ["#5693"]
    tests:
      [
        "bounded-contexts/marketplace/features/reports/api/runtime.test.ts",
        "bounded-contexts/platform-operations/features/reported-content/read-model/projection.test.ts",
      ]
  - claim: Accounts move through an event-sourced active, suspended, and closed state machine, and content moderation can escalate an account for suspension.
    issues: ["#5693"]
    tests:
      [
        "bounded-contexts/identity/features/accounts/domain/domain.test.ts",
        "bounded-contexts/platform-operations/features/reported-content/read-model/projection.test.ts",
      ]
---

## Your listings and other people's work

Two rules cover most intellectual-property situations on Chase Sets:

- **Sell genuine products.** Every listing is created against a Chase Sets catalog entry, and the item you ship must genuinely be that product. Counterfeits and reproductions presented as genuine are covered in [Prohibited and restricted items](/help/selling/prohibited-and-restricted-items).
- **Use your own photos and words.** Your listing photos must show your actual item. Copying another seller's photos can be flagged with a stolen-photos report, and using content you have no right to use can also draw a formal infringement notice.

If someone reports your listing, it goes to Trust & Safety review; enough distinct reports unlist an active listing automatically while a person reviews it. Every moderation action is recorded with who took it and why.

## Two ways to raise an infringement problem

If content on Chase Sets uses your work without permission, you can raise it two ways:

1. **Report it in place.** Use the report control on the listing — for example a counterfeit concern or stolen photos. This is the fastest path for straightforward cases and is open to anyone.
2. **Send a formal DMCA notice.** The Digital Millennium Copyright Act gives copyright owners a formal notice-and-takedown path, described below. Use it when you want the statutory process, when you act for another rights holder, or when the in-place report does not fit the situation.

## What a DMCA notice must contain

Under [Section 512 of the Copyright Act](https://www.copyright.gov/512/), a notification of claimed infringement must include, in substance (reviewed against the U.S. Copyright Office's Section 512 materials on August 2, 2026):

- identification of the copyrighted work you claim is infringed, or a representative list if there are many
- identification of the material you claim is infringing, with enough location detail — on Chase Sets, the listing or review URL — for it to be found
- your name, address, telephone number, and email address
- a statement that you have a good-faith belief the use is not authorized by the copyright owner, its agent, or the law
- a statement that the information in the notice is accurate and, under penalty of perjury, that you are authorized to act for the copyright owner
- your physical or electronic signature

A knowingly false claim of infringement carries legal exposure under the statute, so send a notice only for work you own or are authorized to act for.

## Where to send a notice

Send DMCA notices for Chase Sets to the designated contact:

Todd Skelton, Chase Sets Limited, PO Box 164, Maize, KS 67101-0164, US.

For general questions about a notice you sent or received, you can also reach [support@chasesets.com](mailto:support@chasesets.com).

As of the August 2, 2026 review, a matching current record for this contact could not be verified in the U.S. Copyright Office's public [DMCA Designated Agent Directory](https://dmca.copyright.gov/osp/), so this article carries the status marker `registration-status-unverified`. This marker is removed only when a current directory record is verified.

## If your listing is taken down: counter-notices

If material you posted is removed after an infringement notice and you believe the removal was a mistake or misidentification, Section 512 provides a counter-notice path. A counter-notice must include, in substance:

- your physical or electronic signature
- identification of the removed material and where it appeared before removal
- a statement under penalty of perjury that you have a good-faith belief the material was removed as a result of mistake or misidentification
- your name, address, and telephone number, and consent to federal court jurisdiction as the statute describes

Send counter-notices to the same contact listed above; a person reviews each one under the statute's procedure. The statute provides that a service provider restores material no less than ten and no more than fourteen business days after receiving a valid counter-notice, unless the original claimant notifies the provider that it has filed a court action seeking to restrain the alleged infringement.

## Repeat infringement

Section 512 conditions its safe harbor on a policy that provides for terminating repeat infringers in appropriate circumstances. On Chase Sets, infringement findings can escalate beyond the listing: content moderation can escalate an account for suspension, and an account can be suspended or, for the most serious cases, closed. A suspended account can be reactivated once the underlying issue is resolved; closure is final.

This article describes the statutory framework and Chase Sets' handling in plain language; it is not legal advice, and questions about your own rights or exposure belong with your own counsel.
