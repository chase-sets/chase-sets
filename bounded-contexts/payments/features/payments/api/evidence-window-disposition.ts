import {
  providerWriteIdempotencyKey,
  requireProviderWrite,
  type EvidenceWindowProviderWrite,
  type ProviderCancelGovernance,
  type ProviderObjectClass,
  type ProviderWriteRow,
} from "@chase-sets/evidence-window-provider-write";
import type { PaymentProcessorGateway, ProcessorSetupSessionCancellationResult } from "@chase-sets/payment-processing";
import { parseProviderModeObservation, type ProviderModeObservation } from "./contracts";
// The purpose-specific capture composition supplies the shipped receipt policy.
// Payments owns execution, not a second copy of the schema or budget table.
export type EvidenceWindowDispositionReceiptPolicy = Readonly<{
  version: string;
  classTable: readonly Readonly<{
    class: string;
    declaredBudget: number;
    budgetScope: string;
    precedenceOrdinal: number;
    successStates: readonly string[];
  }>[];
  computeResultDigest: (document: unknown) => string;
  validateProviderObjectDisposition: (document: unknown) => Readonly<{ ok: boolean }>;
}>;

type ClassResult = {
  class: string;
  state: string;
  declaredBudget: number;
  budgetScope: string;
  precedenceOrdinal: number;
  enumerationComplete: boolean;
  correlationSource: string;
  observedCount: number | null;
  dispositionStartedAt: string | null;
  dispositionCompletedAt: string | null;
};

export type EvidenceWindowDispositionAuthority = Readonly<{
  windowId: string;
  expiresAt: string;
  providerMode: "test";
}>;

export type EvidenceWindowDispositionOptions = Readonly<{
  processorGateway: PaymentProcessorGateway;
  journal?: EvidenceWindowProviderWrite;
  providerModeObservation?: ProviderModeObservation;
  // Supplied by the separately admitted host, never by a request body or environment flag.
  authority?: () => Promise<EvidenceWindowDispositionAuthority | null>;
  requestCapturedRemedy?: (row: ProviderWriteRow) => Promise<boolean>;
  crossCheck?: (objectClass: ProviderObjectClass) => Promise<
    Readonly<{
      references: readonly string[];
      total: number;
      complete: boolean;
      capHit: boolean;
      nextLink: string | null;
      membershipQualified: boolean;
    }>
  >;
}>;

export function setupDisposition(result: ProcessorSetupSessionCancellationResult): string {
  switch (result.outcome) {
    case "cancelled":
      return "cancelled";
    case "already-terminal":
      return "already-terminal";
    case "not-found":
      return "unknown";
    case "refused":
      return result.reason === "invalid-reference" || result.reason === "provider-rejected"
        ? "disposition-failed"
        : "unknown";
  }
}

export function createEvidenceWindowDisposition(options: EvidenceWindowDispositionOptions) {
  return async (windowId: string, policy: EvidenceWindowDispositionReceiptPolicy) => {
    const { classTable: OPTION_B_CLASS_TABLE, computeResultDigest, validateProviderObjectDisposition } = policy;
    const startedAt = new Date().toISOString();
    const classes: ClassResult[] = OPTION_B_CLASS_TABLE.map((row) => ({
      class: row.class,
      state: "not-attempted",
      declaredBudget: row.declaredBudget,
      budgetScope: row.budgetScope,
      observedCount: null,
      enumerationComplete: false,
      correlationSource: "not-applicable",
      precedenceOrdinal: row.precedenceOrdinal,
      dispositionStartedAt: null,
      dispositionCompletedAt: null,
    }));
    const observation = parseProviderModeObservation(options.providerModeObservation);
    const finish = (variant: string, reason?: string) => {
      const document = {
        version: policy.version,
        variant,
        emittedBy: "executor",
        startedAt,
        finishedAt: new Date().toISOString(),
        deploymentEnvironment: observation?.deploymentEnvironment === "dev" ? "dev" : "test",
        providerMode: "test",
        windowId: /^[a-f0-9]{32}$/.test(windowId) ? windowId : "0".repeat(32),
        classes,
        ...(variant === "pre-network-refusal" ? { refusal: reason } : {}),
        ...(variant === "cleanup-failure" ? { failure: reason } : {}),
        resultDigest: "",
      };
      document.resultDigest = computeResultDigest(document);
      if (!validateProviderObjectDisposition(document).ok) throw new Error("Invalid disposition receipt");
      return document;
    };
    // Validate the fixture-derived table before any journal or provider activity.
    finish("pre-network-refusal", "authority-unavailable");
    if (!/^[a-f0-9]{32}$/.test(windowId)) return finish("pre-network-refusal", "invalid-input");
    if (observation?.deploymentEnvironment === "production" || observation?.mode === "live")
      return finish("pre-network-refusal", "production-environment");
    if (!observation || observation.mode !== "test" || !["dev", "test"].includes(observation.deploymentEnvironment))
      return finish("pre-network-refusal", "authority-unavailable");
    let authority: EvidenceWindowDispositionAuthority | null;
    try {
      authority = (await options.authority?.()) ?? null;
    } catch {
      authority = null;
    }
    if (
      !authority ||
      authority.windowId !== windowId ||
      authority.providerMode !== "test" ||
      !Number.isFinite(Date.parse(authority.expiresAt)) ||
      Date.parse(authority.expiresAt) <= Date.now()
    )
      return finish("pre-network-refusal", "authority-unavailable");
    const journal = options.journal;
    if (!journal) return finish("pre-network-refusal", "journal-unavailable");
    let rows: readonly ProviderWriteRow[];
    try {
      rows = await journal.readWindow(windowId);
    } catch {
      return finish("pre-network-refusal", "journal-unavailable");
    }
    if (
      rows.length > 646 ||
      rows.some((row) => row.key.windowId !== windowId) ||
      new Set(rows.map((row) => providerWriteIdempotencyKey(row.key))).size !== rows.length
    )
      return finish("pre-network-refusal", "journal-unavailable");
    let failure = "cleanup-incomplete";
    let creations = rows.filter((row) => row.key.operation === "create");
    const governance = async (original: ProviderWriteRow): Promise<ProviderCancelGovernance> => {
      const key = { ...original.key, operation: "dispose" as const };
      const current = (await journal.readWindow(windowId)).find(
        (row) => providerWriteIdempotencyKey(row.key) === providerWriteIdempotencyKey(key),
      );
      return {
        kind: "governed",
        rowKey: key,
        expectedVersion: current?.version ?? 1,
        idempotencyKey: providerWriteIdempotencyKey(key),
      };
    };
    for (const table of [...OPTION_B_CLASS_TABLE].sort((a, b) => a.precedenceOrdinal - b.precedenceOrdinal)) {
      const index = OPTION_B_CLASS_TABLE.indexOf(table);
      const objectClass = (index + 1) as ProviderObjectClass;
      const entry = classes[index]!;
      const inventory = creations.filter((row) => (row.observedClass ?? row.key.objectClass) === objectClass);
      const unknown = () => {
        entry.state = "unknown";
        entry.observedCount = null;
        entry.enumerationComplete = false;
        entry.dispositionCompletedAt = null;
      };
      entry.dispositionStartedAt = new Date().toISOString();
      entry.correlationSource = "creation-time-record";
      if (
        Date.now() >= Date.parse(authority.expiresAt) ||
        inventory.some((row) => row.state === "pending" || row.state === "ambiguous")
      ) {
        unknown();
        continue;
      }
      const created = inventory.filter((row) => row.state === "succeeded");
      try {
        if (options.crossCheck && objectClass <= 4) {
          const check = await options.crossCheck(objectClass);
          const known = new Set(created.map((row) => row.providerReference));
          if (
            !check.complete ||
            check.capHit ||
            check.nextLink !== null ||
            !check.membershipQualified ||
            !Number.isSafeInteger(check.total) ||
            check.total !== check.references.length ||
            check.total !== known.size ||
            new Set(check.references).size !== check.references.length ||
            check.references.some((reference) => !known.has(reference))
          ) {
            unknown();
            failure = "correlation-discrepancy";
            continue;
          }
          entry.correlationSource = "creation-time-record-plus-provider-cross-check";
        }
        entry.observedCount = created.length;
        entry.enumerationComplete = true;
        switch (objectClass) {
          case 1:
            entry.state = "remedy-requested";
            for (const row of created) {
              if (!(await options.requestCapturedRemedy?.(row))) {
                unknown();
                break;
              }
            }
            break;
          case 2:
          case 3: {
            entry.state = "already-terminal";
            for (const row of created) {
              if (!row.providerReference) {
                unknown();
                break;
              }
              let state: string;
              if (objectClass === 3) {
                state = setupDisposition(
                  await options.processorGateway.cancelSetupSession(row.providerReference, await governance(row)),
                );
              } else if (!row.providerReference.startsWith("pi_")) {
                state = "disposition-failed";
              } else {
                const before = await options.processorGateway.retrievePaymentResult(row.providerReference);
                if (before?.processorStatus === "succeeded") {
                  const captured = requireProviderWrite(await journal.observeCapture(row.key, row.version));
                  creations = creations.map((candidate) => (candidate === row ? captured : candidate));
                  state = "already-terminal";
                } else if (before?.processorStatus === "canceled") state = "already-terminal";
                else if (!before) state = "unknown";
                else {
                  let result;
                  let reconciled = false;
                  try {
                    result = await options.processorGateway.cancelPayment(row.providerReference, await governance(row));
                  } catch {
                    reconciled = true;
                    result = await options.processorGateway.retrievePaymentResult(row.providerReference);
                  }
                  if (result?.processorStatus === "succeeded") {
                    const captured = requireProviderWrite(await journal.observeCapture(row.key, row.version));
                    creations = creations.map((candidate) => (candidate === row ? captured : candidate));
                    state = "already-terminal";
                  } else
                    state =
                      result?.processorStatus === "canceled"
                        ? reconciled
                          ? "already-terminal"
                          : "cancelled"
                        : "unknown";
                }
              }
              if (state === "unknown") {
                unknown();
                break;
              }
              if (state === "disposition-failed") entry.state = state;
              else {
                entry.observedCount = entry.observedCount! - 1;
                if (state === "cancelled" && entry.state !== "disposition-failed") entry.state = state;
              }
            }
            break;
          }
          case 4:
            if (created.length) unknown();
            else {
              entry.state = "not-created";
              entry.dispositionStartedAt = null;
            }
            break;
          case 5:
            entry.state = "retained-reused";
            break;
          case 6:
            if (created.some((row) => row.logicalSlot === null)) unknown();
            else entry.state = "budgeted-residue";
            break;
          default:
            unknown();
        }
        if (entry.state !== "unknown" && entry.state !== "not-created")
          entry.dispositionCompletedAt = new Date().toISOString();
      } catch {
        unknown();
      }
    }
    // A creation completing or arriving during cleanup invalidates the inventory snapshot.
    // Do not publish absence or a zero residue from a stale read.
    try {
      const current = (await journal.readWindow(windowId)).filter((row) => row.key.operation === "create");
      if (
        current.length !== creations.length ||
        current.some(
          (row) =>
            !creations.some(
              (original) =>
                providerWriteIdempotencyKey(original.key) === providerWriteIdempotencyKey(row.key) &&
                original.version === row.version &&
                original.state === row.state &&
                original.observedClass === row.observedClass &&
                original.providerReference === row.providerReference,
            ),
        )
      )
        throw new Error("inventory-changed");
    } catch {
      failure = "correlation-discrepancy";
      for (const entry of classes) {
        entry.state = "unknown";
        entry.observedCount = null;
        entry.enumerationComplete = false;
        entry.dispositionCompletedAt = null;
        if (entry.dispositionStartedAt === null) entry.correlationSource = "not-applicable";
      }
    }
    const overBudget = classes.some(
      (entry) => entry.observedCount !== null && entry.observedCount > entry.declaredBudget,
    );
    const successful =
      !overBudget && classes.every((entry, index) => OPTION_B_CLASS_TABLE[index]!.successStates.includes(entry.state));
    return finish(successful ? "success" : "cleanup-failure", overBudget ? "budget-exceeded" : failure);
  };
}
