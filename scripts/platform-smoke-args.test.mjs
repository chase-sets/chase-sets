import { describe, expect, it } from "vitest";
import { getPlatformSmokeCliArgs } from "./platform-smoke-args.mjs";

describe("platform smoke CLI args", () => {
  it("uses positional URLs directly", () => {
    expect(getPlatformSmokeCliArgs(["node", "platform-smoke.mjs", "https://landing.test"]))
      .toEqual(["https://landing.test"]);
  });

  it("ignores a leading pnpm argument separator", () => {
    expect(
      getPlatformSmokeCliArgs([
        "node",
        "platform-smoke.mjs",
        "--",
        "https://landing.test",
        "https://admin.test",
      ]),
    ).toEqual(["https://landing.test", "https://admin.test"]);
  });
});
