import type {
  SavedListCommandReceipt,
  SavedListProductSelection,
  SavedListLineChangeErrorCode,
} from "../domain/contracts";
import type {
  AddProductToSavedListRequest,
  SavedListDestination,
  SavedListDiscoverySurface,
} from "./discovery-contracts";

export type PrepareSavedListOperation = Readonly<{
  product: SavedListProductSelection;
  trackedQuantity: number;
  sourceSurface: SavedListDiscoverySurface;
}>;

export type SavedListRecoveryReceipt = Omit<SavedListCommandReceipt, "lineResults"> &
  Readonly<{
    lineResults: readonly Readonly<{
      operationId: string;
      lineId: string | null;
      status: SavedListCommandReceipt["lineResults"][number]["status"];
      errorCode: string | null;
    }>[];
  }>;

export type SavedListRecoveryOperation = Readonly<{
  operationId: string;
  revision: number;
  sendRevision: number | null;
  status: "prepared" | "confirmed" | "unknown" | "applied" | "rejected" | "expired";
  draft: PrepareSavedListOperation;
  request: AddProductToSavedListRequest | null;
  createdAt: string;
  terminalAt: string | null;
  result: Readonly<{ receipt: SavedListRecoveryReceipt }> | null;
  lineResults: readonly Readonly<{
    operationId: string;
    lineId: string | null;
    status: "applied" | "rejected" | "unknown";
    errorCode: SavedListLineChangeErrorCode | null;
  }>[];
}>;

export type SavedListRecoveryPage = Readonly<{
  items: readonly SavedListRecoveryOperation[];
  nextCursor: string | null;
}>;

export type SavedListOperationReference = Readonly<{ operationId: string; revision: number }>;
export type ConfirmSavedListOperation = SavedListOperationReference & Readonly<{ destination: SavedListDestination }>;
export type ReserveAnonymousSavedListOperation = Readonly<{
  intentId: string;
  destination: SavedListDestination;
  trackedQuantity: number;
}>;
