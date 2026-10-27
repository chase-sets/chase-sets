import { expect, test } from "@playwright/test";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { deployedOriginFakeSeam } from "./loopback-platform";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("connector-pairing-drill-deployed exact-origin resolver", () => {
  const staging = linkIntentOrigins["marketplace-web"].staging;
  const seam = deployedOriginFakeSeam(staging, "http://127.0.0.1:46174");
  expect(seam.resolveOrigin!(new URL(`${staging}/account/channels`))).toBe("http://127.0.0.1:46174/account/channels");
  expect(() => seam.resolveOrigin!(new URL("https://marketplace.example/account/channels"))).toThrow(
    "connector-drill-fake-origin-refused",
  );
});
