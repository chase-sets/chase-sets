import {
  normalizeWalletAdjustmentReasonCode,
  type WalletAdjustmentReasonCode,
} from "../../features/wallets/domain/wallet-adjustment";

/**
 * The guided credit/debit flow's submitted field values, shared by the UI
 * form and the route adapter that reads them back off
 * `FormData`. Lives in `support/request-support` rather than `routes/` or
 * `features/*\/ui` so both the route (composition-only, never touching
 * domain internals directly) and the UI can depend on the same shape without
 * either layer reaching into the other's internals (structure gate).
 */
export type WalletAdjustmentGuidedFlowValues = Readonly<{
  direction: "credit" | "debit";
  amount: string;
  reasonCode: WalletAdjustmentReasonCode;
  explanation: string;
  evidenceReferences: readonly string[];
}>;

export const WALLET_ADJUSTMENT_FORM_INTENTS = {
  preview: "preview-adjustment",
  request: "request-adjustment",
  approve: "approve-adjustment",
  reject: "reject-adjustment",
  reverse: "reverse-adjustment",
} as const;

export type WalletAdjustmentFormIntent =
  (typeof WALLET_ADJUSTMENT_FORM_INTENTS)[keyof typeof WALLET_ADJUSTMENT_FORM_INTENTS];

export const WALLET_ADJUSTMENT_GUIDED_FLOW_DEFAULT_VALUES: WalletAdjustmentGuidedFlowValues = {
  direction: "credit",
  amount: "",
  reasonCode: "transaction-correction",
  explanation: "",
  evidenceReferences: [],
};

function readReasonCode(value: FormDataEntryValue | null): WalletAdjustmentReasonCode {
  try {
    return normalizeWalletAdjustmentReasonCode(String(value ?? ""));
  } catch {
    return "transaction-correction";
  }
}

export function readWalletAdjustmentGuidedFlowValues(formData: FormData): WalletAdjustmentGuidedFlowValues {
  return {
    direction: formData.get("direction") === "debit" ? "debit" : "credit",
    amount: String(formData.get("amount") ?? ""),
    reasonCode: readReasonCode(formData.get("reasonCode")),
    explanation: String(formData.get("explanation") ?? ""),
    evidenceReferences: formData
      .getAll("evidenceReferences")
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0),
  };
}
