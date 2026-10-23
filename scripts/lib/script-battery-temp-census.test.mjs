import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupScriptBatteryTempCensus } from "./script-battery-temp-census.mjs";

describe("script battery temporary census", () => {
  it("uses one fresh private directory for every temporary environment", async () => {
    const teardown = await setupScriptBatteryTempCensus();
    const privateDirectory = process.env.TEMP;
    try {
      expect(privateDirectory).toBeTruthy();
      expect(process.env.TMP).toBe(privateDirectory);
      expect(process.env.TMPDIR).toBe(privateDirectory);
      expect(os.tmpdir()).toBe(privateDirectory);
    } finally {
      await teardown();
    }
  });

  it("fails the script battery when a test leaves a temporary entry", async () => {
    const teardown = await setupScriptBatteryTempCensus();
    const privateDirectory = process.env.TEMP;
    const leakedDirectory = await mkdtemp(path.join(privateDirectory, "inert-leak-"));
    await expect(teardown()).rejects.toThrow(
      `script battery temporary census found surviving entries: ${path.basename(leakedDirectory)}`,
    );
    expect(() => os.tmpdir()).not.toThrow();
    await rm(leakedDirectory, { recursive: true, force: true });
  });
});
