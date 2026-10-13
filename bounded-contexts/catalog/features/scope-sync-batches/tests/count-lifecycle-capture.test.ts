import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCountCaptureRequest } from "../api/count-capture-context";
import { sendCatalogProviderRequest } from "../../source-observations/api/providers/provider-send-admission";

// Synthetic HTTP destination mapping retains the production URL classifier;
// the transport sends only to this process's loopback server, without credentials.
describe("rejects unsafe lifecycle", () => {
  let server: Server;
  let origin: string;
  let requests: string[];
  let redirect = false;
  beforeAll(async () => {
    requests = [];
    server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (redirect) {
        response.writeHead(302, { location: `${origin}/redirected` });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic loopback listener unavailable.");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  });

  it("counts concurrent possible sends across two cold request contexts without transferring slots", async () => {
    requests = [];
    redirect = false;
    let debits = 0;
    const ledger = {
      debit: vi.fn(async () => {
        if (debits >= 4) throw new Error("synthetic-cap");
        return ++debits;
      }),
      result: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const transport: typeof fetch = (input, init) => fetch(`${origin}${new URL(String(input)).pathname}`, init);
    const invoke = (requestId: string) =>
      runCountCaptureRequest(
        {
          binding: { runId: "synthetic-run", requestId, phase: "preview" },
          ledger,
        },
        () =>
          sendCatalogProviderRequest(
            "scrydex",
            transport,
            "https://api.scrydex.com/account/v1/usage",
            undefined,
            "usage",
          ),
      );
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => invoke(`synthetic-${index % 2}`)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(debits).toBe(4);
    expect(requests).toEqual(Array.from({ length: 4 }, () => "/account/v1/usage"));
  });

  it("never follows a real redirect or releases its possible-send slot", async () => {
    requests = [];
    redirect = true;
    const ledger = {
      debit: vi.fn(async () => 1),
      result: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const transport: typeof fetch = (input, init) => fetch(`${origin}${new URL(String(input)).pathname}`, init);
    await expect(
      runCountCaptureRequest(
        {
          binding: { runId: "synthetic-run", requestId: "synthetic-redirect", phase: "preview" },
          ledger,
        },
        () =>
          sendCatalogProviderRequest(
            "scrydex",
            transport,
            "https://api.scrydex.com/account/v1/usage",
            undefined,
            "usage",
          ),
      ),
    ).rejects.toThrow("capture-stopped");
    expect(requests).toEqual(["/account/v1/usage"]);
    expect(ledger.debit).toHaveBeenCalledTimes(1);
    expect(ledger.result).not.toHaveBeenCalled();
    expect(ledger.stop).toHaveBeenCalled();
  });
});
