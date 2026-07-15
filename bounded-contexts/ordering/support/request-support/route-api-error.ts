import { defineApiErrorAdapter } from "@chase-sets/platform-runtime/http";
import { OrderingApiError } from "../../client";

export const orderingApiErrorAdapter = defineApiErrorAdapter({
  isError: (error): error is OrderingApiError =>
    error instanceof OrderingApiError ||
    (error instanceof Error && "status" in error && typeof error.status === "number" && "body" in error),
  getStatus: (error) => error.status,
  getBody: (error) => error.body,
});
