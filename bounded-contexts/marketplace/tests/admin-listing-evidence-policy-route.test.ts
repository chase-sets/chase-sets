import { afterEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, readFreshWriteToken } from "@chase-sets/http/responses";
import { action, loader } from "../routes/admin/listing-evidence-policy";
import { jsonResponse, requestUrl } from "./test-support/http";

const receiptSource = { sourceContextName: "marketplace", maxGlobalPosition: "71", eventIds: ["evt_policy_rejected"] };

function policyWriteResponse() {
  return jsonResponse({ documentId: "pol_1", version: 2 }, 200, {
    "Chase-Sets-Consistency": "eventual",
    "Chase-Sets-Commit-Receipt": encodeURIComponent(JSON.stringify([receiptSource])),
  });
}

async function postIntent(fields: Record<string, string>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const response = await action({
    request: new Request("http://localhost/platform/listing-evidence-policy", { method: "POST", body: form }),
    params: {},
    context: undefined,
  } as never);
  if (!(response instanceof Response)) throw new Error("Expected a redirect response.");
  return response;
}

describe("admin Listing Evidence Policy route after a write", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects to the overview carrying the write's receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (requestUrl(input).endsWith("/api/marketplace/listing-evidence-policy/drafts/pol_1/reject")) {
          return policyWriteResponse();
        }
        throw new Error(`Unexpected fetch request: ${requestUrl(input)}`);
      }),
    );

    const response = await postIntent({ intent: "reject", policyId: "pol_1" });

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toMatch(/^\/platform\/listing-evidence-policy\?afterWrite=/);
    expect(readFreshWriteToken(location)?.sources).toEqual([receiptSource]);
  });

  it("sends that receipt on the overview read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (requestUrl(input).endsWith("/api/marketplace/listing-evidence-policy/drafts/pol_1/reject")) {
          return policyWriteResponse();
        }
        throw new Error(`Unexpected fetch request: ${requestUrl(input)}`);
      }),
    );
    const location = (await postIntent({ intent: "reject", policyId: "pol_1" })).headers.get("Location") ?? "";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ documents: [], selectors: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await loader({
      request: new Request(new URL(location, "http://localhost")),
      params: {},
      context: undefined,
    } as never);

    const overviewCall = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).endsWith("/api/marketplace/listing-evidence-policy"),
    );
    const sent = new Headers(overviewCall?.[1]?.headers).get(CHASE_SETS_READ_AFTER_WRITE_HEADER);
    expect(sent).toBeTruthy();
    expect(readFreshWriteToken(`/?afterWrite=${encodeURIComponent(sent ?? "")}`)?.sources).toEqual([receiptSource]);
  });
});
