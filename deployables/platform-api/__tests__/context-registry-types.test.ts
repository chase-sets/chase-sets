import { describe, expectTypeOf, it } from "vitest";
import type { PlatformApiContextName } from "../src/config";
import type { PlatformWorkerContextName } from "../../platform-worker/src/config";

type ExpectedPlatformContextName =
  | "auth"
  | "authenticity"
  | "catalog"
  | "checkout"
  | "collections"
  | "commercial-terms"
  | "customer-feedback"
  | "discovery"
  | "fulfillment"
  | "identity"
  | "inventory"
  | "marketplace"
  | "notifications"
  | "ordering"
  | "payments"
  | "platform-operations"
  | "pricing"
  | "public-presence"
  | "settlement";

describe("hand-authored context registry literal unions", () => {
  it("retains the exact platform API and worker context-name unions", () => {
    expectTypeOf<PlatformApiContextName>().toEqualTypeOf<ExpectedPlatformContextName>();
    expectTypeOf<PlatformWorkerContextName>().toEqualTypeOf<ExpectedPlatformContextName>();

    const unboundedName: string = "auth";
    // @ts-expect-error a plain string must not widen into the registry's literal union
    const apiFromString: PlatformApiContextName = unboundedName;
    // @ts-expect-error an unregistered name must not enter the API union
    const bogusApi: PlatformApiContextName = "bogus-context";
    // @ts-expect-error a plain string must not widen into the registry's literal union
    const workerFromString: PlatformWorkerContextName = unboundedName;
    // @ts-expect-error an unregistered name must not enter the worker union
    const bogusWorker: PlatformWorkerContextName = "bogus-context";

    expectTypeOf(apiFromString).toEqualTypeOf<PlatformApiContextName>();
    expectTypeOf(bogusApi).toEqualTypeOf<PlatformApiContextName>();
    expectTypeOf(workerFromString).toEqualTypeOf<PlatformWorkerContextName>();
    expectTypeOf(bogusWorker).toEqualTypeOf<PlatformWorkerContextName>();
  });
});
