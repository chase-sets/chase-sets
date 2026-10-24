import { expect, it } from "vitest";
import { mutatedOutboundRuntime } from "./runtime-mutation-support";

it.each(["omission-guard", "receipt-identity", "transaction-split"] as const)(
  "binds the exact %s source mutant to real runtime dependencies",
  (mutant) => {
    expect(mutatedOutboundRuntime(mutant)).toBeTypeOf("function");
  },
);
