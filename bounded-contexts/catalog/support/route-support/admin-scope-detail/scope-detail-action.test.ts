import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDispatchIntegrationsCommand } = vi.hoisted(() => ({
  mockDispatchIntegrationsCommand: vi.fn(),
}));

vi.mock("../admin-integrations/integrations-command-dispatch", () => ({
  dispatchIntegrationsCommand: mockDispatchIntegrationsCommand,
}));

const { action } = await import("./scope-detail-action");

function formRequest(fields: Record<string, string>) {
  const body = new URLSearchParams(fields);
  return new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

function runAction(fields: Record<string, string>) {
  return action({ request: formRequest(fields), params: {}, context: {} } as unknown as ActionFunctionArgs);
}

describe("Catalog scope-detail route action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["alias.accept", "job-queued", "success"],
    ["scope.sync", "job-queued", "success"],
    ["observation.promote", "preview-ready", "success"],
    ["candidate.defer", "reason-required", "error"],
  ] as const)("delegates %s through the shared entity dispatcher", async (intent, result, status) => {
    const commandResult = {
      feedback: { status, intent, result },
      context: { section: "import-to-promotion", selectedObservationIds: [] },
      section: "import-to-promotion",
    };
    mockDispatchIntegrationsCommand.mockResolvedValue(commandResult);

    await expect(runAction({ _intent: intent })).resolves.toEqual(commandResult);
    expect(mockDispatchIntegrationsCommand).toHaveBeenCalledTimes(1);
  });

  it("preserves detailed dispatcher failures for the scope feedback banner", async () => {
    const commandResult = {
      feedback: { status: "error", intent: "alias.accept", result: "command-failed" },
      context: { section: "import-to-promotion", selectedObservationIds: [] },
      section: "import-to-promotion",
    };
    mockDispatchIntegrationsCommand.mockResolvedValue(commandResult);

    await expect(runAction({ _intent: "alias.accept" })).resolves.toEqual(commandResult);
  });
});
