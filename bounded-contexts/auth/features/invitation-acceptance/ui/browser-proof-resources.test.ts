import { describe, expect, it, vi } from "vitest";
import { createBrowserProofResources, runBrowserProof } from "./browser-proof-resources";

describe("Invitation browser proof resource ownership", () => {
  it("context rejection still closes server", async () => {
    const resources = createBrowserProofResources();
    const failure = new Error("context rejected");
    const server = vi.fn(async () => {});
    const context = vi.fn(async () => {
      throw failure;
    });
    resources.release(server);
    resources.release(context);

    const error = await resources.dispose().catch((error: unknown) => error);
    expect(context).toHaveBeenCalledTimes(1);
    expect(server).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ errors: [failure] });
    await expect(resources.dispose()).rejects.toMatchObject({ errors: [failure] });
    expect(server).toHaveBeenCalledTimes(1);
  });

  it("shares concurrent disposal and finishes tracing before either close", async () => {
    const resources = createBrowserProofResources();
    const trace = Promise.withResolvers<void>();
    const server = vi.fn(async () => {});
    const context = vi.fn(async () => {});
    const stop = vi.fn(() => trace.promise);
    resources.release(server);
    resources.release(context);
    resources.beforeDispose(stop);

    const first = resources.dispose();
    expect(resources.dispose()).toBe(first);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(server).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
    trace.resolve();
    await first;
    await resources.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(context).toHaveBeenCalledTimes(1);
    expect(server).toHaveBeenCalledTimes(1);
  });

  it("releases partial allocation and preserves its primary error", async () => {
    const server = vi.fn(async () => {});
    const allocation = new Error("context allocation failed");
    await expect(
      runBrowserProof(async (resources) => {
        resources.release(server);
        throw allocation;
      }),
    ).rejects.toBe(allocation);
    expect(server).toHaveBeenCalledTimes(1);
  });

  it.each(["assertion", "trace start", "trace stop", "scan"])(
    "preserves %s failure and independent cleanup errors",
    async (phase) => {
      const primary = new Error(phase);
      const context = new Error("context close");
      const server = new Error("server close");
      const result = runBrowserProof(async (resources) => {
        resources.release(async () => {
          throw server;
        });
        resources.release(async () => {
          throw context;
        });
        throw primary;
      });
      await expect(result).rejects.toMatchObject({ errors: [primary, { errors: [context, server] }] });
    },
  );

  it.each(["trace stop", "scan"])(
    "preserves failure-path %s rejection without retry or skipped closes",
    async (phase) => {
      const resources = createBrowserProofResources();
      const failure = new Error(phase);
      const cleanup = vi.fn(async () => {
        throw failure;
      });
      const server = vi.fn(async () => {});
      const context = vi.fn(async () => {});
      resources.beforeDispose(cleanup);
      resources.release(server);
      resources.release(context);
      await expect(resources.dispose()).rejects.toMatchObject({ errors: [failure] });
      await expect(resources.dispose()).rejects.toMatchObject({ errors: [failure] });
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(server).toHaveBeenCalledTimes(1);
      expect(context).toHaveBeenCalledTimes(1);
    },
  );

  it("does not let a synchronous close throw prevent another release", async () => {
    const resources = createBrowserProofResources();
    const server = vi.fn(async () => {});
    const failure = new Error("synchronous close");
    resources.release(server);
    resources.release(() => {
      throw failure;
    });
    await expect(resources.dispose()).rejects.toMatchObject({ errors: [failure] });
    expect(server).toHaveBeenCalledTimes(1);
  });

  it("releases success once and rejects late registrations", async () => {
    const release = vi.fn(async () => {});
    await runBrowserProof(async (resources) => {
      resources.release(release);
      await resources.dispose();
      expect(() => resources.release(release)).toThrow("already disposing");
      expect(() => resources.beforeDispose(release)).toThrow("already registered or started");
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
