import { describe, expect, it, vi } from "vitest";
import {
  createGracefulFetch,
  createProcessDrainState,
  shutdownGracefully,
  type GracefulHttpServerHandle,
} from "./process-lifecycle";

describe("process lifecycle", () => {
  it("tracks active response streams until the body is consumed", async () => {
    let closeStream: (() => void) | undefined;
    const drainState = createProcessDrainState();
    const fetch = createGracefulFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("hello"));
              closeStream = () => controller.close();
            },
          }),
        ),
      drainState,
    );

    const response = await fetch(new Request("http://localhost/stream"));

    expect(drainState.activeRequestCount()).toBe(0);
    expect(drainState.activeStreamCount()).toBe(1);

    const reader = response.body?.getReader();
    await reader?.read();
    closeStream?.();
    await reader?.read();

    expect(drainState.activeStreamCount()).toBe(0);
  });

  it("marks readiness state as draining before shutdown callbacks close resources", async () => {
    const events: string[] = [];
    const drainState = createProcessDrainState();
    const server: GracefulHttpServerHandle = {
      close: (callback) => {
        events.push("server.close");
        callback?.();
      },
      closeIdleConnections: () => events.push("server.closeIdleConnections"),
    };

    await shutdownGracefully({
      name: "test-process",
      reason: "SIGTERM",
      server,
      drainState,
      shutdownGraceMs: 100,
      streamDrainGraceMs: 50,
      onDrainStart: [
        () => {
          events.push(`drain:${drainState.isDraining()}`);
        },
      ],
      onShutdown: [
        () => {
          events.push("shutdown");
        },
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(events).toEqual(["drain:true", "server.closeIdleConnections", "server.close", "shutdown"]);
  });
});
