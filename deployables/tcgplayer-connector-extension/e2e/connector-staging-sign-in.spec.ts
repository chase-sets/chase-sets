import { test, expect } from "@playwright/test";
import { createStagingPersonaSignIn } from "./pairing-drill-staging";

test.describe("connector staging persona sign-in", () => {
  test("requires the composed drill to use the server-issued adapter", async ({ browser }) => {
    const context = await browser.newContext();
    await expect(createStagingPersonaSignIn()(context, "not-a-persona")).rejects.toMatchObject({
      code: "connector-drill-sign-in-unavailable",
    });
    await context.close();
  });
});
