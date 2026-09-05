import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH_SESSION_STATUSES } from "../../features/sessions/ui/list-filters";
import {
  agentGrantOutcomeLabel,
  agentGrantStatusLabel,
  agentGrantStatusValues,
  sessionStatusLabel,
} from "./value-labels";

const authRoot = path.resolve(import.meta.dirname, "../..");

function quotedValues(source: string, declaration: RegExp): string[] {
  const match = declaration.exec(source);
  return match ? [...match[0].matchAll(/"([^"]+)"/g)].map((value) => value[1]) : [];
}

describe("Auth value labels", () => {
  it("labels every current Auth value", () => {
    const linkedAuthorizationStore = readFileSync(
      path.resolve(authRoot, "../identity/support/ucp-support/linked-platform-authorizations.ts"),
      "utf8",
    );
    const observedAgentGrantStatuses = [
      ...new Set([...linkedAuthorizationStore.matchAll(/'(active|revoked)'/g)].map((match) => match[1])),
    ].sort();
    const agentGrantContracts = readFileSync(path.resolve(authRoot, "features/agent-grants/ui/contracts.ts"), "utf8");
    const observedOutcomes = quotedValues(agentGrantContracts, /outcome:\s*"[^"]+"(?:\s*\|\s*"[^"]+")+;/);

    expect(AUTH_SESSION_STATUSES.map((value) => sessionStatusLabel(value))).toEqual(["Active", "Revoked", "Expired"]);
    expect([...agentGrantStatusValues].sort()).toEqual(observedAgentGrantStatuses);
    expect(agentGrantStatusValues.map((value) => agentGrantStatusLabel(value))).toEqual(["Active", "Revoked"]);
    expect(observedOutcomes.map((value) => agentGrantOutcomeLabel(value))).toEqual(["Allowed", "Denied", "Failed"]);
  });

  it("keeps unknown Auth values distinct from the All statuses filter", () => {
    expect(sessionStatusLabel("future-status")).toBe("Unrecognized Session status: Future Status");
    expect(sessionStatusLabel("acc_unsafe")).toBe("Unrecognized Session status");
    expect(sessionStatusLabel("future-status")).not.toBe("All statuses");
  });
});
