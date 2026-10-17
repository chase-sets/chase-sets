import { createHash } from "node:crypto";
import type { DomainEvent } from "@chase-sets/event-core";
import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { parseTypedId, type AccountId, type LedgerEntryId, type UserId } from "@chase-sets/primitives/typed-ids";
import type { WalletState, WalletEvent, WalletCommand } from "./domain";
import { SettlementDomainError } from "../../../support/runtime-support/common";

export const STAGING_PROOF = "7806-ac6";
export const STAGING_PROOF_DOCUMENT = "settlement-staging-proof-credit-7806-ac6";
export const STAGING_PROOF_RULING = "https://github.com/chase-sets/chase-sets/issues/7806#issuecomment-6041721954";
export const STAGING_PROOF_CAP = "25.00";
export const STAGING_PROOF_REASON = "staging-operator-proof";

export class StagingProofCreditError extends SettlementDomainError {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function requireProof(condition: unknown, code: string): asserts condition {
  if (!condition) throw new StagingProofCreditError(code);
}

export function proofCreditAmount(value: unknown): string {
  requireProof(typeof value === "string" && /^(?:0|[1-9]\d?)\.\d{2}$/.test(value), "proof_amount_invalid");
  const cents = Number(value.replace(".", ""));
  requireProof(cents >= 1 && cents <= 2500, "proof_amount_invalid");
  return value;
}

export type StagingProofPolicyValue = Readonly<{ enabled: boolean; proofAccountId: AccountId | null }>;
export function decodeStagingProofPolicy(raw: JsonValue): StagingProofPolicyValue {
  requireProof(typeof raw === "object" && raw !== null && !Array.isArray(raw), "proof_policy_invalid");
  requireProof(Object.keys(raw).length === 2 && "enabled" in raw && "proofAccountId" in raw, "proof_policy_invalid");
  requireProof(typeof raw.enabled === "boolean", "proof_policy_invalid");
  const proofAccountId = raw.proofAccountId === null ? null : parseTypedId(String(raw.proofAccountId), "acc");
  requireProof(!raw.enabled || proofAccountId !== null, "proof_policy_invalid");
  return { enabled: raw.enabled, proofAccountId };
}
export const stagingProofCreditPolicy = definePolicy<StagingProofPolicyValue>({
  policyKey: "settlement.staging-proof-credit",
  contextName: "settlement",
  schemaSummary: "{ enabled: boolean, proofAccountId: AccountId | null }; immutable account pin; staging only",
  defaultValue: { enabled: false, proofAccountId: null },
  decodeValue: decodeStagingProofPolicy,
});

export function proofLedgerId(accountId: AccountId): LedgerEntryId {
  return parseTypedId(
    `led_${createHash("sha256").update(`${STAGING_PROOF}:${accountId}`).digest("hex").slice(0, 26)}`,
    "led",
  );
}

export type StagingProofReceipt = Readonly<{
  actorUserId: UserId;
  accountId: AccountId;
  environment: "staging";
  proof: typeof STAGING_PROOF;
  amount: string;
  currencyCode: "usd";
  cap: typeof STAGING_PROOF_CAP;
  policyDocumentId: typeof STAGING_PROOF_DOCUMENT;
  policyVersion: number;
  recentlyAuthenticated: true;
  authenticatedAt: string;
  recentAuthMaxAgeMinutes: number;
  reason: typeof STAGING_PROOF_REASON;
  ruling: typeof STAGING_PROOF_RULING;
  postedAt: string;
  ledgerEntryId: LedgerEntryId;
}>;
export type StagingProofCreditPostedEvent = DomainEvent<
  "settlement.wallet.staging-proof-credit-posted",
  StagingProofReceipt
>;
export type PostStagingProofCreditCommand = Readonly<{ type: "PostStagingProofCredit"; receipt: StagingProofReceipt }>;

export function validateProofReceipt(receipt: StagingProofReceipt): void {
  requireProof(receipt && typeof receipt === "object", "proof_history_invalid");
  parseTypedId(receipt.actorUserId, "usr");
  parseTypedId(receipt.accountId, "acc");
  proofCreditAmount(receipt.amount);
  requireProof(
    receipt.environment === "staging" &&
      receipt.proof === STAGING_PROOF &&
      receipt.currencyCode === "usd" &&
      receipt.cap === STAGING_PROOF_CAP &&
      receipt.reason === STAGING_PROOF_REASON &&
      receipt.ruling === STAGING_PROOF_RULING &&
      receipt.policyDocumentId === STAGING_PROOF_DOCUMENT &&
      Number.isSafeInteger(receipt.policyVersion) &&
      receipt.policyVersion > 0 &&
      receipt.recentlyAuthenticated === true &&
      receipt.ledgerEntryId === proofLedgerId(receipt.accountId),
    "proof_history_invalid",
  );
  const posted = Date.parse(receipt.postedAt);
  const authenticated = Date.parse(receipt.authenticatedAt);
  requireProof(
    Number.isFinite(posted) &&
      new Date(posted).toISOString() === receipt.postedAt &&
      Number.isFinite(authenticated) &&
      new Date(authenticated).toISOString() === receipt.authenticatedAt &&
      Number.isSafeInteger(receipt.recentAuthMaxAgeMinutes) &&
      receipt.recentAuthMaxAgeMinutes > 0 &&
      authenticated <= posted &&
      posted - authenticated <= receipt.recentAuthMaxAgeMinutes * 60_000,
    "proof_history_invalid",
  );
}

export function readProofReceipt(state: WalletState, accountId: AccountId): StagingProofReceipt | null {
  const entries = state.entries.filter((entry) => entry.ledgerEntryId === proofLedgerId(accountId));
  const audits = state.stagingProofCredits;
  if (entries.length === 0 && audits.length === 0) return null;
  requireProof(entries.length === 1 && audits.length === 1, "proof_history_invalid");
  const receipt = audits[0]!;
  validateProofReceipt(receipt);
  const entry = entries[0]!;
  requireProof(
    state.accountId === accountId &&
      state.currencyCode === "usd" &&
      receipt.accountId === accountId &&
      entry.amount === receipt.amount &&
      entry.currencyCode === "usd" &&
      entry.kind === "adjustment" &&
      entry.direction === "credit" &&
      entry.fundsStatus === "available" &&
      entry.postedAt === receipt.postedAt &&
      entry.orderId === null &&
      entry.paymentId === null &&
      entry.payoutId === null &&
      entry.description === STAGING_PROOF_REASON,
    "proof_history_invalid",
  );
  return receipt;
}

export function decideStagingProofCredit(
  state: WalletState,
  command: PostStagingProofCreditCommand,
  decide: (state: WalletState, command: WalletCommand) => readonly WalletEvent[],
  evolve: (state: WalletState, event: WalletEvent) => WalletState,
): readonly WalletEvent[] {
  const receipt = command.receipt;
  validateProofReceipt(receipt);
  requireProof(state.accountId === null || state.accountId === receipt.accountId, "proof_account_mismatch");
  requireProof(state.currencyCode === null || state.currencyCode === "usd", "proof_currency_mismatch");
  const prior = readProofReceipt(state, receipt.accountId);
  if (prior) {
    requireProof(prior.amount === receipt.amount, "proof_amount_conflict");
    return [];
  }
  const opening = decide(state, {
    type: "OpenWallet",
    accountId: receipt.accountId,
    currencyCode: "usd",
    openedAt: receipt.postedAt,
  });
  const opened = opening.reduce(evolve, state);
  const credit = decide(opened, {
    type: "PostLedgerEntry",
    ledgerEntryId: receipt.ledgerEntryId,
    kind: "adjustment",
    direction: "credit",
    amount: receipt.amount,
    currencyCode: "usd",
    fundsStatus: "available",
    description: STAGING_PROOF_REASON,
    postedAt: receipt.postedAt,
  });
  return [...opening, ...credit, { type: "settlement.wallet.staging-proof-credit-posted", data: receipt }];
}
