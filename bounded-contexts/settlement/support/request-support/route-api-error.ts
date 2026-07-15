import { defineApiErrorAdapter } from "@chase-sets/platform-runtime/http";
import { SettlementApiError } from "../../client";

export const settlementApiErrorAdapter = defineApiErrorAdapter({
  isError: (error): error is SettlementApiError =>
    error instanceof SettlementApiError ||
    (error instanceof Error && "status" in error && typeof error.status === "number" && "body" in error),
  getStatus: (error) => error.status,
  getBody: (error) => error.body,
});
