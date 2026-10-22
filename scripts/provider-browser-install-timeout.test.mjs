import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INSTALLER_TIMEOUT_GRACE_MS,
  INSTALLER_TIMEOUT_SECONDS,
  INSTALLER_STEP,
} from "./provider-browser-install-timeout.mjs";

const workflow = readFileSync(".github/workflows/platform-pr.yml", "utf8");
const diagnosticWorkflow = readFileSync(".github/workflows/browser-boundary-diagnostics.yml", "utf8");
const wrapper = readFileSync("scripts/provider-browser-install-timeout.mjs", "utf8");
const staticJob = workflow.slice(workflow.indexOf("  static:"), workflow.indexOf("  typecheck:"));

describe("Static Checks provider install timeout", () => {
  it("static checks provider install timeout propagation", () => {
    expect(INSTALLER_TIMEOUT_SECONDS).toBe(600);
    expect(staticJob).toContain("INSTALLER_TIMEOUT_SECONDS: \"600\"");
    expect(INSTALLER_TIMEOUT_GRACE_MS).toBe(5_000);
    expect(wrapper).toContain('detached: true');
    expect(wrapper).toContain('process.kill(-child.pid, "SIGTERM")');
    expect(wrapper).toContain('process.kill(-child.pid, "SIGKILL")');
    expect(staticJob).toContain("timeout-minutes: 20");
    expect(staticJob).toContain(INSTALLER_STEP);
    expect(staticJob).not.toContain("continue-on-error");
    expect(staticJob).toContain("name: Installed-boundary controls");
    expect(staticJob).toContain("name: Remove owned provider browser boundary");
    expect(diagnosticWorkflow).toContain("timeout-minutes: 60");
    expect(diagnosticWorkflow).toContain("run: bash scripts/provider-object-disposition/browser-boundary/ci-setup.sh");
    expect(diagnosticWorkflow).toContain("name: Installed-boundary diagnostic subset (NOT PROVEN)");
  });

  it.each([
    ["partial download fails closed", "partial-download"],
    ["checksum failure fails closed", "checksum-failure"],
    ["cache restore failure fails closed", "cache-restore-failure"],
    ["cleanup failure fails closed", "cleanup-failure"],
    ["secret and raw provider response are never logged", "safeLine"],
    ["fallback browser path is refused", "refused"],
  ])("%s", (_name, marker) => expect(wrapper).toContain(marker));
});
