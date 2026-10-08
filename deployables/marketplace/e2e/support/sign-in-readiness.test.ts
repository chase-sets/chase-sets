import { describe, expect, it } from "vitest";
import { hasIdentifierSubmitHandler } from "./sign-in-readiness";

describe("identifier submit-handler readiness", () => {
  it("rejects SSR markup without React props", () => {
    expect(hasIdentifierSubmitHandler({})).toBe(false);
  });

  it("rejects React metadata without a callable submit handler", () => {
    for (const props of [null, {}, { onSubmit: undefined }, { onSubmit: "handler" }]) {
      expect(hasIdentifierSubmitHandler({ __reactProps$test: props })).toBe(false);
    }
    expect(hasIdentifierSubmitHandler({ __reactFiber$test: { onSubmit() {} } })).toBe(false);
  });

  it("accepts a callable submit handler on the inspected form", () => {
    expect(hasIdentifierSubmitHandler({ __reactProps$test: { onSubmit() {} } })).toBe(true);
  });

  it("does not mistake a descendant handler for form readiness", () => {
    expect(hasIdentifierSubmitHandler({ children: [{ __reactProps$test: { onSubmit() {} } }] })).toBe(false);
  });
});
