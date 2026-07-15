import { defineApiErrorAdapter } from "@chase-sets/platform-runtime/http";
import { IdentityApiError } from "../../client";

export const identityApiErrorAdapter = defineApiErrorAdapter({
  isError: (error): error is IdentityApiError =>
    error instanceof IdentityApiError ||
    (error instanceof Error && "status" in error && typeof error.status === "number" && "body" in error),
  getStatus: (error) => error.status,
  getBody: (error) => error.body,
});
