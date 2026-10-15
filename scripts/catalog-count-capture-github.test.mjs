import { describe, expect, it, vi } from "vitest";
import { countCaptureGitHubLimits, createCountCaptureGitHubReader } from "./catalog-count-capture-github.mjs";

const refusal = "count-capture-deployment-unknown";
const runsPath = "/actions/runs?per_page=100&page=1&created=2026-09-08T05:11:30Z..2026-10-13T08:02:00Z";
const jobsPath = "/actions/runs/38349636491/attempts/1/jobs?per_page=100&page=1";
const attemptPath = "/actions/runs/38349636491/attempts/1";
function reader(transport, limits) {
  return createCountCaptureGitHubReader({
    repository: "synthetic/repository",
    token: "synthetic-private-token",
    transport,
    limits: limits ?? countCaptureGitHubLimits,
  });
}
// A JSON document of exactly the requested byte length.
function jsonOfBytes(bytes) {
  const shell = JSON.stringify({ total_count: 0, workflow_runs: [], pad: "" });
  return JSON.stringify({ total_count: 0, workflow_runs: [], pad: "x".repeat(bytes - shell.length) });
}

describe("bounded capture GitHub transport", () => {
  it("reads only exact allowlisted paths with the token, manual redirects and no retry", async () => {
    const transport = vi.fn(async () => Response.json({ total_count: 0, workflow_runs: [] }));
    const client = reader(transport);
    expect(await client.json(runsPath)).toEqual({ total_count: 0, workflow_runs: [] });
    expect(await client.json(jobsPath)).toEqual({ total_count: 0, workflow_runs: [] });
    expect(await client.json(attemptPath)).toEqual({ total_count: 0, workflow_runs: [] });
    expect(transport).toHaveBeenCalledWith(
      `https://api.github.com/repos/synthetic/repository${runsPath}`,
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({ authorization: "Bearer synthetic-private-token" }),
      }),
    );
    for (const path of [
      "https://example.com",
      "/actions/runs?per_page=100&page=1",
      "/actions/runs?per_page=100&page=1&created=2026-09-08..2026-10-13",
      "/actions/runs?head_sha=abc",
      "/actions/runs/../secrets",
      "/actions/runs/1/attempts/1/jobs?per_page=100&page=0",
      "/actions/runs/1/attempts/0",
      "/actions/runs/1/attempts/1?exclude_pull_requests=true",
      "/actions/runs/1/attempts/1/logs",
      "/actions/workflows?per_page=100&page=1",
    ])
      await expect(client.json(path)).rejects.toThrow(refusal);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("reads a head-bound workflow definition raw at an exact commit only", async () => {
    const transport = vi.fn(async () => new Response("name: synthetic\n"));
    const client = reader(transport);
    expect(await client.workflow(".github/workflows/platform-production.yml", "a".repeat(40))).toBe(
      "name: synthetic\n",
    );
    expect(transport).toHaveBeenCalledWith(
      `https://api.github.com/repos/synthetic/repository/contents/.github/workflows/platform-production.yml?ref=${"a".repeat(40)}`,
      expect.objectContaining({ headers: expect.objectContaining({ accept: "application/vnd.github.raw+json" }) }),
    );
    for (const [path, ref] of [
      ["dynamic/dependabot/dependabot-updates", "a".repeat(40)],
      [".github/workflows/../../secrets.yml", "a".repeat(40)],
      [".github/workflows/platform-production.yml", "main"],
    ])
      await expect(client.workflow(path, ref)).rejects.toThrow(refusal);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not forward the token to GitHub's single signed log download", async () => {
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
    "https://synthetic.blob.core.windows.net:8443/log",
  ])("refuses an untrusted log destination %s without following it", async (location) => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    await expect(reader(transport).jobLog("123")).rejects.toThrow(refusal);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not retry HTTP failures or follow a second redirect", async () => {
    const failing = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(reader(failing).json(runsPath)).rejects.toThrow(refusal);
    expect(failing).toHaveBeenCalledTimes(1);
    const twice = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://synthetic.blob.core.windows.net/log" } }),
    );
    await expect(reader(twice).jobLog("123")).rejects.toThrow(refusal);
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["json page", (client) => client.json(runsPath), countCaptureGitHubLimits.jsonBytes, jsonOfBytes],
    [
      "workflow definition",
      (client) => client.workflow(".github/workflows/platform-production.yml", "a".repeat(40)),
      countCaptureGitHubLimits.workflowBytes,
      (bytes) => "#".repeat(bytes),
    ],
    ["job log", (client) => client.jobLog("123"), countCaptureGitHubLimits.logBytes, (bytes) => "l".repeat(bytes)],
  ])(
    "accepts the largest valid %s and refuses one byte more, with or without Content-Length",
    async (_kind, read, cap, body) => {
      await expect(read(reader(async () => new Response(body(cap))))).resolves.toBeTruthy();
      await expect(read(reader(async () => new Response(body(cap + 1))))).rejects.toThrow(refusal);
      const declared = vi.fn(async () => new Response("{}", { headers: { "content-length": String(cap + 1) } }));
      await expect(read(reader(declared))).rejects.toThrow(refusal);
    },
  );

  // Headers arrive at 100 ms and the body then trickles forever. With one 150 ms
  // deadline the read is already rejected at 160 ms; a fresh body deadline would
  // still be pending then, as would a transport that never answers.
  it("fails an endless body and hung headers within the same active deadline", async () => {
    vi.useFakeTimers();
    try {
      const limits = { ...countCaptureGitHubLimits, deadlineMs: 150 };
      const endless = () => {
        let cancelled = false;
        return new Response(
          new ReadableStream({
            pull: (controller) =>
              new Promise((resolve) =>
                setTimeout(() => {
                  if (!cancelled) controller.enqueue(new TextEncoder().encode(" "));
                  resolve();
                }, 20),
              ),
            cancel: () => {
              cancelled = true;
            },
          }),
        );
      };
      const slow = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(endless()), 100)));
      const hung = vi.fn(() => new Promise(() => {}));
      const settled = (promise) =>
        promise.then(
          () => "resolved",
          (error) => error.message,
        );
      const body = settled(reader(slow, limits).json(runsPath));
      const headers = settled(reader(hung, limits).jobLog("123"));
      await vi.advanceTimersByTimeAsync(160);
      expect(await Promise.race([body, Promise.resolve("pending")])).toBe(refusal);
      expect(await Promise.race([headers, Promise.resolve("pending")])).toBe(refusal);
      expect(slow.mock.calls[0][1].signal.aborted).toBe(true);
      expect(hung.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses malformed JSON and invalid UTF-8 value-free", async () => {
    await expect(reader(async () => new Response("{")).json(runsPath)).rejects.toThrow(refusal);
    await expect(reader(async () => new Response(new Uint8Array([0xff, 0xfe]))).jobLog("123")).rejects.toThrow(refusal);
  });
});
