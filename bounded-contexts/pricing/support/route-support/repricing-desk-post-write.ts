import { UnresolvedPostWriteTokenError } from "@chase-sets/platform-runtime/http";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";

const FRESH_WRITE_SEARCH_PARAMS = ["afterWrite", "postWriteHandoff", "postWriteToken"] as const;

function requestWithoutSearchParams(request: Request, names: readonly string[]) {
  const url = new URL(request.url);
  if (!names.some((name) => url.searchParams.has(name))) {
    return request;
  }

  for (const name of names) {
    url.searchParams.delete(name);
  }
  return new Request(url.toString(), { headers: request.headers });
}

// Expands a compact post-write token into its receipt. An unknown or expired
// token degrades to an ordinary read, so the Desk keeps its normal 404 and
// permission handling instead of failing the whole page.
export async function resolveRepricingDeskPostWriteRequest(request: Request): Promise<Request> {
  try {
    return await resolvePlatformPostWriteRequest(request);
  } catch (error) {
    if (error instanceof UnresolvedPostWriteTokenError) {
      return requestWithoutSearchParams(request, ["postWriteToken"]);
    }
    throw error;
  }
}

// Halt, budget, dry-run, and activity reads do not depend on the policy
// projection, so they never carry the write receipt into the freshness gate.
export function repricingDeskRequestWithoutFreshWrite(request: Request): Request {
  return requestWithoutSearchParams(request, FRESH_WRITE_SEARCH_PARAMS);
}
