import { describe, expect, it, vi } from "vitest";
import { runTcgplayerSetNames } from "../../../domain/extension/set-names/run";
import type { SetNamesPost } from "../../../domain/extension/set-names/transport";
import { counts, entry, observedAt, response } from "./fixture";

describe("SetNames Run", () => {
  it.each([1, 2, 3, 68])(
    "fetches bound product line %s once and grant-posts the entire response once",
    async (productLineId) => {
      const request = vi.fn(async () => response({ errors: [], results: [entry({ categoryId: productLineId })] }));
      const post = vi.fn<SetNamesPost>(async () => ({ outcome: "recorded", ...counts }));
      expect(
        await runTcgplayerSetNames({ productLineId, environment: "staging", request, post, now: () => observedAt }),
      ).toEqual({ outcome: "recorded", ...counts });
      expect(request).toHaveBeenCalledExactlyOnceWith(String(productLineId));
      expect(post).toHaveBeenCalledExactlyOnceWith("staging", {
        contractVersion: 1,
        productLineId,
        observedAt,
        sets: [entry({ categoryId: productLineId })],
      });
    },
  );
  it.each([71, 82, 0, NaN])("never requests or posts unbound line %s", async (productLineId) => {
    const request = vi.fn();
    const post = vi.fn();
    expect(await runTcgplayerSetNames({ productLineId, environment: "staging", request, post })).toEqual({
      outcome: "refused",
    });
    expect(request).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
