import { describe, expect, it, vi } from "vitest";
import type { BcContextManifest } from "@chase-sets/bounded-context-module";
import { attachReadConsistencyMiddleware } from "@chase-sets/bounded-context-runtime";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, encodeFreshWriteReceipt } from "@chase-sets/http/responses";
import { contextManifest } from "../../../index";

const manifest = contextManifest as BcContextManifest;

describe("newly activated connection manual-sync freshness", () => {
  it.each([null, "channel-connection-projection", "tcgplayer-csv-projection"])(
    "waits for its actual read projections, not policy documents (behind: %s)",
    async (behind) => {
      const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
      const groups = contextManifest.projectionGroups.map((group) => ({
        targetContextName: "channels",
        projectionName: group.projectionName,
        ownedTables: group.ownedTables,
        subscriptionRunners: [
          {
            sourceContextName: "channels",
            refreshStatus: vi.fn(async () => ({
              lastGlobalPosition:
                group.projectionName === behind || group.projectionName === "platform-policy-document-projection"
                  ? "1"
                  : "5",
              state: "running",
            })),
          },
        ],
      }));
      attachReadConsistencyMiddleware(
        { use: (_path, middleware) => middlewares.push(middleware) },
        manifest.apiMounts!.map((mount) => ({ ...mount, contextName: "channels" })),
        groups,
        { timeoutMs: 0, pollIntervalMs: 1 },
      );
      const receipt = encodeFreshWriteReceipt({
        observedAtMs: Date.now(),
        sources: [{ sourceContextName: "channels", maxGlobalPosition: "5", eventIds: ["activation-event"] }],
      });
      const next = vi.fn(async () => {});
      const result = await middlewares[0](
        {
          req: {
            method: "GET",
            path: "/api/channels/connections/new-connection/manual-sync",
            header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
          },
          json: (body: unknown, status: number) => ({ body, status }),
        },
        next,
      );
      expect(
        groups.find((group) => group.projectionName === "platform-policy-document-projection")!.subscriptionRunners[0]
          .refreshStatus,
      ).not.toHaveBeenCalled();
      if (behind) {
        expect(next).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          status: 503,
          body: {
            error: {
              code: "projection_freshness_timeout",
              pending: [expect.objectContaining({ projectionName: behind })],
            },
          },
        });
      } else {
        expect(next).toHaveBeenCalledOnce();
        for (const projectionName of ["channel-connection-projection", "tcgplayer-csv-projection"]) {
          expect(
            groups.find((group) => group.projectionName === projectionName)!.subscriptionRunners[0].refreshStatus,
          ).toHaveBeenCalledOnce();
        }
      }
    },
  );
});
