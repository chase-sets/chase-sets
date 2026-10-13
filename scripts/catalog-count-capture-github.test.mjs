import { describe, expect, it, vi } from "vitest";
import { createCountCaptureGitHubReader } from "./catalog-count-capture-github.mjs";

function reader(transport) {
  return createCountCaptureGitHubReader({
    repository: "synthetic/repository",
    token: "synthetic-private-token",
    transport,
  });
}
describe("bounded capture GitHub transport", () => {
  it("uses the exact repository and a closed paginated actions path", async () => {
    const transport = vi.fn(async () => Response.json({ total_count: 0, workflows: [] }));
    const client = reader(transport);
    expect(await client.json("/actions/workflows?per_page=100&page=1")).toEqual({ total_count: 0, workflows: [] });
    expect(transport).toHaveBeenCalledWith(
      "https://api.github.com/repos/synthetic/repository/actions/workflows?per_page=100&page=1",
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({ authorization: "Bearer synthetic-private-token" }),
      }),
    );
    for (const path of [
      "https://example.com",
      "/actions/runs?head_sha=abc",
      "/actions/runs/../secrets",
      "/actions/runs?per_page=100&page=0",
    ])
      await expect(client.json(path)).rejects.toThrow("count-capture-deployment-unknown");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not forward the token to the single GitHub signed-log redirect", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://synthetic.blob.core.windows.net/log?signature=synthetic" },
        }),
      )
      .mockResolvedValueOnce(new Response("synthetic log"));
    expect(await reader(transport).jobLog("123")).toBe("synthetic log");
    expect(transport.mock.calls[1][1].headers).toEqual({});
    expect(transport.mock.calls[1][1].redirect).toBe("manual");
  });
  it.each([
    "https://evil.example/log",
    "http://synthetic.blob.core.windows.net/log",
    "https://synthetic.blob.core.windows.net.evil.example/log",
    "https://user@synthetic.blob.core.windows.net/log",
  ])("refuses an untrusted log destination %s without following it", async (location) => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    await expect(reader(transport).jobLog("123")).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not retry HTTP failures or follow a second log redirect", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(reader(transport).json("/actions/runs?per_page=100&page=1")).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("bounds streamed bytes even without Content-Length", async () => {
    const transport = vi.fn(async () => new Response(new Uint8Array(4_000_001)));
    await expect(reader(transport).json("/actions/runs?per_page=100&page=1")).rejects.toThrow();
  });
});
