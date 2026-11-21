import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

type FulfillmentContextManifest = Readonly<{
  hostPorts?: readonly Readonly<{ portName: string; providedBy?: string; purpose?: string }>[];
}>;

describe("fulfillment host ports", () => {
  // The platform runtime hands a context only the host ports its manifest declares, so an
  // undeclared port reaches the services as undefined however the deployable builds it.
  it("declares the deployable-provided ports Fulfillment's services use", () => {
    const context = JSON.parse(
      readFileSync(resolve(repoRoot, "bounded-contexts/fulfillment/context.json"), "utf8"),
    ) as FulfillmentContextManifest;
    const hostPorts = new Map((context.hostPorts ?? []).map((entry) => [entry.portName, entry.providedBy]));

    expect(Object.fromEntries(hostPorts)).toEqual({
      operatorAuthority: "platform-api",
      postageLabelProvider: "platform-api",
      postageWebhookGateway: "platform-api",
      returnIntakeEvidenceStorage: "platform-api",
      notificationOutbox: "platform-worker",
    });
  });
});
