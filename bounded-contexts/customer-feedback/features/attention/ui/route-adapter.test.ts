import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFeedbackAttentionRouteData } from "./route-adapter";

const payload = { items: [], metrics: {} };

function stubFetch() {
  const fetchMock = vi.fn(async () => Response.json(payload));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof stubFetch>): URL {
  const [input] = (fetchMock.mock.calls[0] ?? []) as unknown as [URL];
  return new URL(String(input));
}

describe("loadFeedbackAttentionRouteData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the API for the case a deep link names and returns it to the surface", async () => {
    const fetchMock = stubFetch();
    const data = await loadFeedbackAttentionRouteData(
      new Request("https://admin.test/support/customer-feedback/attention?caseId=fbcase_01JQZZ0000000000000000000B"),
    );

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/api/customer-feedback/attention");
    expect(url.searchParams.get("caseId")).toBe("fbcase_01JQZZ0000000000000000000B");
    expect(data.caseId).toBe("fbcase_01JQZZ0000000000000000000B");
  });

  it("reads the full queue without a case", async () => {
    const fetchMock = stubFetch();
    const data = await loadFeedbackAttentionRouteData(
      new Request("https://admin.test/support/customer-feedback/attention"),
    );

    expect(requestedUrl(fetchMock).searchParams.has("caseId")).toBe(false);
    expect(data.caseId).toBeNull();
  });
});
