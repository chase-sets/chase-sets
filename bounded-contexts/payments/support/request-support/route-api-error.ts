import { defineApiErrorAdapter } from "@chase-sets/platform-runtime/http";
import { PaymentsApiError } from "../../client";

export const paymentsApiErrorAdapter = defineApiErrorAdapter({
  isError: (error): error is PaymentsApiError =>
    error instanceof PaymentsApiError ||
    (error instanceof Error && "status" in error && typeof error.status === "number" && "body" in error),
  getStatus: (error) => error.status,
  getBody: (error) => error.body,
});
