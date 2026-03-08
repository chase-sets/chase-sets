import type { Context } from "hono";

export function errorHandler(error: Error, c: Context): Response {
  console.error("Unhandled error:", error);
  return c.json({ error: "Internal server error." }, 500);
}
