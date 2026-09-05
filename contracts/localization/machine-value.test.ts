import { describe, expect, it } from "vitest";
import { createTranslator } from "./index";
import { authenticationMethodLabel, formatMachineValue, humanizeMachineToken, safeMachineToken } from "./machine-value";

const { t } = createTranslator({ locale: "en" });

describe("machine value presentation", () => {
  it("labels known Authentication Methods without changing their raw keys", () => {
    expect(authenticationMethodLabel("password", t)).toBe("Password");
    expect(authenticationMethodLabel("magic-link", t)).toBe("Magic link");
    expect(authenticationMethodLabel("sms-code", t)).toBe("SMS code");
    expect(authenticationMethodLabel("google", t)).toBe("Google login");
  });

  it("does not leak unsafe unknown machine values or alias them as defaults", () => {
    const options = {
      knownValueTranslationKeys: {},
      family: "status",
      translate: t,
      unrecognizedTranslationKey: "identity.values.unrecognized",
      unrecognizedWithValueTranslationKey: "identity.values.unrecognized.withValue",
    } as const;

    expect(formatMachineValue("future-method", options)).toBe("Unrecognized status: Future Method");

    for (const unsafe of [
      "person@example.com",
      "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "future method",
      "future\nmethod",
      "x".repeat(41),
    ]) {
      const label = formatMachineValue(unsafe, options);
      expect(label).toBe("Unrecognized status");
      expect(label).not.toContain(unsafe);
      expect(label).not.toBe("All statuses");
    }
  });

  it("keeps safe-token checks and humanization pure across repeated calls", () => {
    expect(safeMachineToken("future-method")).toBe("future-method");
    expect(safeMachineToken("future_method")).toBeNull();
    expect(humanizeMachineToken("future-method")).toBe("Future Method");
    expect(humanizeMachineToken("future-method")).toBe("Future Method");
  });
});
