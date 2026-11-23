import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPublicationSettings } from "../domain/contracts";
import { ChannelsPublicationApiError, createChannelsPublicationRequestApiClient } from "./request-client";

const settings: ChannelPublicationSettings = {
  titlePrefix: "",
  titleSuffix: "",
  descriptionFooter: "",
  categoryAllowlist: [],
  excludedListingIds: [],
  publishQuantityCap: null,
  lowStockWithholdUnits: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Publication request API configuration commands", () => {
  const conflict = { kind: "refused", code: "stream-version-conflict" };
  const commands = {
    replaceSettings: (client: ReturnType<typeof createChannelsPublicationRequestApiClient>) =>
      client.replaceSettings("connection-a", settings, 3),
    decideMapping: (client: ReturnType<typeof createChannelsPublicationRequestApiClient>) =>
      client.decideMapping({
        connectionId: "connection-a",
        dimension: "category",
        sourceKey: "source",
        decision: "accept",
        targetKey: null,
        expectedStreamVersion: 3,
      }),
  };

  for (const [name, send] of Object.entries(commands)) {
    it(`${name} answers a stale version's 409 as the refusal, not an error`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(conflict, { status: 409 })),
      );
      await expect(send(publicationClient())).resolves.toEqual(conflict);
    });

    it(`${name} still fails on any other 409`, async () => {
      const body = { error: "synthetic conflict" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body, { status: 409 })),
      );
      const result = send(publicationClient());
      await expect(result).rejects.toBeInstanceOf(ChannelsPublicationApiError);
      await expect(result).rejects.toMatchObject({ status: 409, body });
    });
  }
});

it("forwards auth and encodes detail queries and write requests without changing their wire shape", async () => {
  vi.stubEnv("CHASE_SETS_INTERNAL_API_ORIGIN", "http://localhost:6412");
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({}));
  vi.stubGlobal("fetch", fetch);
  const client = publicationClient();

  await client.getConnection("connection/a", "next & page");
  await client.replaceSettings("connection/a", settings, 3);
  await client.decideMapping({
    connectionId: "connection/a",
    dimension: "category",
    sourceKey: "one/two",
    decision: "accept",
    targetKey: "target",
    expectedStreamVersion: 4,
  });

  const calls = fetch.mock.calls.map(([url, init]) => {
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe("session=synthetic-seller");
    expect(headers.get("authorization")).toBe("Bearer synthetic-token");
    expect(headers.get("content-type")).toBe("application/json");
    return [url, init?.method ?? "GET", init?.body];
  });
  const base = "http://localhost:6412/api/channels/publication/connection%2Fa";
  expect(calls).toEqual([
    [`${base}?cursor=next%20%26%20page`, "GET", undefined],
    [`${base}/settings`, "PUT", JSON.stringify({ settings, expectedStreamVersion: 3 })],
    [
      `${base}/mappings/category/one%2Ftwo/decision`,
      "POST",
      JSON.stringify({ decision: "accept", targetKey: "target", expectedStreamVersion: 4 }),
    ],
  ]);
});

function publicationClient() {
  return createChannelsPublicationRequestApiClient(
    new Request("http://localhost:6403/account/channels/publication", {
      headers: { cookie: "session=synthetic-seller", authorization: "Bearer synthetic-token" },
    }),
  );
}
