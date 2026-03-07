import type { Context } from "hono";
import { CatalogDomainError } from "../../../../bounded-contexts/catalog/common";

type EventStoreErrorLike = Readonly<{
  code: string;
  message: string;
}>;

function isEventStoreError(error: unknown): error is EventStoreErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as EventStoreErrorLike).code === "string"
  );
}

export function errorHandler(error: Error, c: Context): Response {
  if (error instanceof CatalogDomainError) {
    return c.json({ error: error.message }, 400);
  }

  if (isEventStoreError(error)) {
    if (error.code === "concurrency_conflict") {
      return c.json({ error: error.message, code: "concurrency_conflict" }, 409);
    }

    console.error("Event store error:", error);
    return c.json({ error: "Internal server error." }, 500);
  }

  console.error("Unhandled error:", error);
  return c.json({ error: "Internal server error." }, 500);
}
