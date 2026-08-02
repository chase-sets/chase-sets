---
slug: tax-reporting-1099k
title: "Tax reporting and Form 1099-K"
description: What Form 1099-K is, the current federal reporting threshold, which reporting questions are still being resolved for Chase Sets, and how taxpayer information fits into payout setup.
audience: seller
category: selling
reviewedAt: "2026-08-02"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: Payout readiness records the payment processor's outstanding requirements, including the tax-id requirement, and payout requests are blocked until payout readiness is ready.
    issues: ["#5693"]
    tests:
      [
        "bounded-contexts/settlement/features/payout-readiness/domain/domain.test.ts",
        "bounded-contexts/settlement/features/payouts/api/runtime.test.ts",
      ]
---

## What Form 1099-K is

Form 1099-K is a U.S. information return. Payment apps and online marketplaces — third-party settlement organizations, in the statute's terms — use it to report payments received for goods or services to the IRS and to the person who received them. It reports gross payment volume; it is not a bill, and it does not by itself decide what tax you owe.

## The federal threshold

As of this article's August 2, 2026 review, the IRS states that third-party settlement organizations are required to file Form 1099-K when the gross amount of payments to a payee for goods or services exceeds $20,000 and the number of transactions exceeds 200, per [Understanding your Form 1099-K](https://www.irs.gov/businesses/understanding-your-form-1099-k) and the [IRS Form 1099-K FAQs](https://www.irs.gov/newsroom/form-1099-k-faqs) (both accessed August 2, 2026). The FAQs note this threshold was retroactively reinstated by legislation, so older articles you find elsewhere may describe thresholds that no longer apply.

Your state may have its own information-reporting rules that differ from the federal threshold; check your state revenue department's current guidance.

## What is still being resolved for Chase Sets

Chase Sets processes buyer payments through its payment processor. Which entity, if any, is the filer of record for reporting on your Chase Sets activity — and how the federal threshold applies to a given account — are questions this article does not decide; they are reserved for review with qualified tax counsel. Do not assume from this article that a form is or is not coming for your activity. When those answers are settled, this article will be revised, and its review date above tells you how current it is.

What ships today is narrower: before your account can receive payouts, payout setup collects identity, business, and taxpayer information through the payment processor, and payout requests are blocked until every outstanding requirement — including the tax-id requirement — is complete. There is currently no tax-form dashboard, running 1099-K threshold tracker, or in-product tax-form delivery in your account.

## What this means in practice

- **Report your income either way.** The IRS is unambiguous that you must report income from selling goods or services on your tax return whether or not you receive a Form 1099-K.
- **Keep your own records.** Your sales history and payout detail, described in [Getting paid](/help/selling/getting-paid), show gross proceeds, fees, and payouts — keep your own copies alongside your cost records, since gross reported volume is not the same as profit.
- **Keep payout information current.** Accurate taxpayer information in payout setup is what keeps your payouts flowing and any required reporting correct.
- **Ask a professional.** How marketplace income, card costs, and collectibles rules interact in your return depends on your situation. This article is general information, not tax advice.

Sales tax is a separate topic with its own rules; see [Sales tax for sellers](/help/selling/sales-tax).
