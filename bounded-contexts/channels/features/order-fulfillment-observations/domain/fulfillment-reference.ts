export async function composeChannelOrderFulfillmentReference(
  externalOrderReference: string,
  providerObservedRevisionOrDigest: string,
): Promise<string> {
  if (typeof externalOrderReference !== "string" || externalOrderReference.length === 0) {
    throw new Error("externalOrderReference must be a nonempty string.");
  }
  if (typeof providerObservedRevisionOrDigest !== "string" || providerObservedRevisionOrDigest.length === 0) {
    throw new Error("providerObservedRevisionOrDigest must be a nonempty string.");
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify(["channel-order-fulfillment/v1", externalOrderReference, providerObservedRevisionOrDigest]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `tcf.v1:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
