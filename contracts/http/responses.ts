export interface ListResponse<T> {
  items: T[];
  total: number;
  count: number;
}

export interface CommandResponse {
  id: string;
  version: number;
  status: string;
}

export type ApiErrorCode =
  | "authentication_required"
  | "authorization_forbidden"
  | "validation_failed"
  | "not_found"
  | "conflict"
  | "provider_failed"
  | "internal_error";

export interface ApiErrorDetail {
  field?: string;
  code?: string;
  message: string;
}

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: ApiErrorDetail[];
  };
}

export function apiErrorResponse(
  code: ApiErrorCode,
  message: string,
  details?: readonly ApiErrorDetail[],
): ApiErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details: [...details] } : {}),
    },
  };
}

export function authenticationRequiredResponse(
  message = "Authentication required.",
): ApiErrorResponse {
  return apiErrorResponse("authentication_required", message);
}

export function forbiddenResponse(
  message = "Forbidden.",
): ApiErrorResponse {
  return apiErrorResponse("authorization_forbidden", message);
}

export function validationFailedResponse(
  message: string,
  details?: readonly ApiErrorDetail[],
): ApiErrorResponse {
  return apiErrorResponse("validation_failed", message, details);
}

export function notFoundResponse(message: string): ApiErrorResponse {
  return apiErrorResponse("not_found", message);
}

export function conflictResponse(message: string): ApiErrorResponse {
  return apiErrorResponse("conflict", message);
}

export function internalErrorResponse(
  message = "Internal server error.",
): ApiErrorResponse {
  return apiErrorResponse("internal_error", message);
}

export function commandResponse(
  id: string,
  version: number,
  status = "accepted",
): CommandResponse {
  return { id, version, status };
}

export function readApiErrorMessage(body: unknown, fallback = "Request failed."): string {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return fallback;
  }

  const error = (body as { error: unknown }).error;
  if (typeof error === "string") {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return fallback;
}
