import { beforeEach, describe, expect, it, vi } from "vitest";

const createBulkRepriceJob = vi.fn();

vi.mock("@chase-sets/platform-runtime/auth", () => ({ requireActorFromAuthApi: vi.fn(async () => ({})) }));
vi.mock("../../request-support/api-client", () => ({
  createPricingRequestApiClient: () => ({ createBulkRepriceJob }),
}));

const { action } = await import("./action");

function upload(fields: Record<string, string>) {
  const form = new FormData();
  form.set("intent", "upload-bulk-reprice");
  form.set("file", new File(["sku,price"], "prices.csv", { type: "text/csv" }));
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const request = new Request("https://synthetic.test/account/bulk-reprice", { method: "POST", body: form });
  return action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);
}

describe("bulk reprice upload action", () => {
  beforeEach(() => {
    createBulkRepriceJob.mockReset();
    createBulkRepriceJob.mockResolvedValue({ jobId: "job_bri_synthetic" });
  });

  it("sends the form's upload attempt so a resent upload lands on its first job", async () => {
    const response = await upload({ idempotencyKey: "attempt-1" });

    expect(createBulkRepriceJob).toHaveBeenCalledWith(
      { csvText: "sku,price", sourceFilename: "prices.csv" },
      "attempt-1",
    );
    expect((response as Response).headers.get("Location")).toBe("/account/bulk-reprice?jobId=job_bri_synthetic");
  });

  it("sends no attempt when the form carried none", async () => {
    await upload({});

    expect(createBulkRepriceJob).toHaveBeenCalledWith(
      { csvText: "sku,price", sourceFilename: "prices.csv" },
      undefined,
    );
  });
});
