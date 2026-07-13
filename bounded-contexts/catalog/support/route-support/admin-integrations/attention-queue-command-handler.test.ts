import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_ATTENTION_DEFER_INTENT,
  CATALOG_ATTENTION_DISMISS_INTENT,
  CATALOG_ATTENTION_RESTORE_INTENT,
} from "../../../features/attention-queue/read-model/attention-intents";
import { handleAttentionQueueCommand } from "./attention-queue-command-handler";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";

type Api = ReturnType<typeof createCatalogRequestApiClient>;

const context = {} as CatalogIntegrationsCommandResult["context"];

function apiWith(dispatch = vi.fn(async () => ({}))): Api {
  return { dispatchCatalogAttentionQueueCommand: dispatch } as unknown as Api;
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
}

describe("handleAttentionQueueCommand", () => {
  it("keeps dismiss on the daily surface (no cross-surface redirect) and dispatches the aggregate", async () => {
    const dispatch = vi.fn(async () => ({}));
    const result = await handleAttentionQueueCommand({
      api: apiWith(dispatch),
      intent: CATALOG_ATTENTION_DISMISS_INTENT,
      context,
      formData: form({ itemKey: "merge-conflict:c1", kind: "merge-conflict", reason: "waiting" }),
    });
    expect(result.section).toBe("import-to-promotion");
    expect(result.feedback.status).toBe("success");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ intent: "dismiss", itemKey: "merge-conflict:c1" }));
  });

  it("keeps defer on the daily surface and passes a re-surface window", async () => {
    const dispatch = vi.fn(async () => ({}));
    const result = await handleAttentionQueueCommand({
      api: apiWith(dispatch),
      intent: CATALOG_ATTENTION_DEFER_INTENT,
      context,
      formData: form({ itemKey: "import-job:j1", kind: "import-job", reason: "later", deferHours: "48" }),
    });
    expect(result.section).toBe("import-to-promotion");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ intent: "defer", deferHours: 48 }));
  });

  it("keeps restore on the daily surface without requiring a reason", async () => {
    const dispatch = vi.fn(async () => ({}));
    const result = await handleAttentionQueueCommand({
      api: apiWith(dispatch),
      intent: CATALOG_ATTENTION_RESTORE_INTENT,
      context,
      formData: form({ itemKey: "alias-candidate:h1" }),
    });
    expect(result.section).toBe("import-to-promotion");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "restore", itemKey: "alias-candidate:h1" }),
    );
  });

  it("fails closed (still on the daily surface) when a park reason is missing", async () => {
    const dispatch = vi.fn(async () => ({}));
    const result = await handleAttentionQueueCommand({
      api: apiWith(dispatch),
      intent: CATALOG_ATTENTION_DISMISS_INTENT,
      context,
      formData: form({ itemKey: "merge-conflict:c1", kind: "merge-conflict" }),
    });
    expect(result.section).toBe("import-to-promotion");
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("reason-required");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
