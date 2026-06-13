import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertCheckoutTransactionalNotificationPolicyCoverage,
  checkoutTransactionalNotificationPolicyDocPath,
  checkoutTransactionalNotificationPolicyEntries,
  checkoutTransactionalNotificationRequiredTriggers,
} from "./checkout-transactional-notification-policy";

describe("Checkout transactional notification policy", () => {
  it("passes the executable coverage assertion", () => {
    expect(() => assertCheckoutTransactionalNotificationPolicyCoverage()).not.toThrow();
  });

  it("defines every required Milestone 17 notification trigger once", () => {
    const triggers = checkoutTransactionalNotificationPolicyEntries.map((entry) => entry.trigger);

    expect(new Set(triggers).size).toBe(triggers.length);
    expect(triggers).toEqual(expect.arrayContaining([...checkoutTransactionalNotificationRequiredTriggers]));
  });

  it("forbids transactional sends before checkout confirmation", () => {
    const preConfirmationEntries = checkoutTransactionalNotificationPolicyEntries.filter(
      (entry) => entry.timing === "before-confirmation",
    );

    expect(preConfirmationEntries.length).toBeGreaterThan(0);
    for (const entry of preConfirmationEntries) {
      expect(entry.channels, entry.trigger).toEqual(["none"]);
      expect(entry.messageTypes, entry.trigger).toEqual([]);
      expect(entry.noCustomerCommittingSideEffectBeforeConfirmation, entry.trigger).toBe(true);
      expect(entry.customerSafeOutcome, entry.trigger).toMatch(/no payment, order, sale/i);
    }
  });

  it("keeps seller pending confirmation from implying completed downstream facts", () => {
    const sellConfirmation = checkoutTransactionalNotificationPolicyEntries.find(
      (entry) => entry.trigger === "sell-confirmation-recorded",
    );

    expect(sellConfirmation?.sourceOwner).toBe("Checkout");
    expect(sellConfirmation?.capabilityStatus).toBe("suppressed");
    expect(sellConfirmation?.messageTypes).toEqual([]);
    expect(sellConfirmation?.pendingDownstreamBoundaryRequired).toBe(true);
    expect(sellConfirmation?.customerSafeOutcome).toMatch(/does not send sale-complete/i);
    expect(sellConfirmation?.customerSafeOutcome).toMatch(/before downstream owners commit/i);
  });

  it("records actual source-owned transactional message types and idempotency shapes", () => {
    const expectedMessageTypes = [
      "ordering.order.created",
      "payments.payment-captured",
      "payments.payment-failed",
      "payments.refund-issued",
      "payments.refund-failed",
      "support.support-request.opened",
      "support.support-request.resolved",
    ];

    const allMessageTypes = checkoutTransactionalNotificationPolicyEntries.flatMap((entry) => entry.messageTypes);
    expect(allMessageTypes).toEqual(expect.arrayContaining(expectedMessageTypes));

    for (const entry of checkoutTransactionalNotificationPolicyEntries.filter((policy) => policy.messageTypes.length)) {
      expect(entry.idempotencyKeyShape, entry.trigger).toContain(":");
      expect(entry.duplicatePreventionRequired, entry.trigger).toBe(true);
    }
  });

  it("documents missing contact, guest receipt, duplicate prevention, and support fallback behavior", () => {
    const guestReceipt = checkoutTransactionalNotificationPolicyEntries.find(
      (entry) => entry.trigger === "guest-receipt-and-account-claim",
    );
    const missingContact = checkoutTransactionalNotificationPolicyEntries.find(
      (entry) => entry.trigger === "missing-contact-fallback",
    );
    const duplicatePrevention = checkoutTransactionalNotificationPolicyEntries.find(
      (entry) => entry.trigger === "duplicate-prevention",
    );

    expect(guestReceipt?.accountClaimBehavior).toBe("disabled");
    expect(guestReceipt?.messageTypes).toContain("ordering.order.created");
    expect(missingContact?.missingContactFallback).toBe("support-runbook");
    expect(missingContact?.messageTypes).toEqual([]);
    expect(duplicatePrevention?.customerSafeOutcome).toMatch(/reload, duplicate submit, job retry/i);
  });

  it("documents the executable transactional notification policy", () => {
    const doc = readFileSync(new URL("../../../docs/checkout-transactional-notifications.md", import.meta.url), "utf8");
    const checkoutReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const docsIndex = readFileSync(new URL("../../../../../docs/README.md", import.meta.url), "utf8");

    expect(checkoutTransactionalNotificationPolicyDocPath).toBe(
      "bounded-contexts/checkout/docs/checkout-transactional-notifications.md",
    );
    expect(doc).toContain("Checkout Transactional Notification Policy");
    expect(doc).toMatch(
      /No transactional message is sent before explicit checkout confirmation\s+or an\s+owning context commit\./,
    );
    expect(doc).toMatch(
      /The executable contract lives in\s+`bounded-contexts\/checkout\/features\/sessions\/api\/checkout-transactional-notification-policy\.ts`\./,
    );
    expect(checkoutReadme).toContain("./docs/checkout-transactional-notifications.md");
    expect(docsIndex).toContain("../bounded-contexts/checkout/docs/checkout-transactional-notifications.md");

    for (const entry of checkoutTransactionalNotificationPolicyEntries) {
      expect(doc, entry.trigger).toContain(`| ${entry.docLabel} |`);
    }
  });
});
