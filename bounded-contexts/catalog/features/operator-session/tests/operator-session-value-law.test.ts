import { describe, expect, it } from "vitest";
import { validateOperatorSessionValue, validateOperatorSessionInstant } from "../domain/value";

describe("operator-session value law", () => {
  it.each(["", "a;b", "a\rb", "a\nb", "a\n", "a b", "a,b", 'a"b', "a\\b", "a\tb", "a\0b", "é", "a".repeat(4097)])(
    "rejects forbidden cookie bytes without reflecting the input (%#)",
    (value) => {
      expect(() => validateOperatorSessionValue(value)).toThrow("invalid-session-value");
    },
  );

  it("accepts exactly RFC 6265 cookie-octet and the inclusive byte limit", () => {
    const octets = Array.from({ length: 127 }, (_, n) => n)
      .filter(
        (n) =>
          n === 0x21 ||
          (n >= 0x23 && n <= 0x2b) ||
          (n >= 0x2d && n <= 0x3a) ||
          (n >= 0x3c && n <= 0x5b) ||
          (n >= 0x5d && n <= 0x7e),
      )
      .map((n) => String.fromCharCode(n))
      .join("");
    expect(() => validateOperatorSessionValue(octets)).not.toThrow();
    expect(() => validateOperatorSessionValue("x".repeat(4096))).not.toThrow();
  });

  it.each(["2026-10-01", "2026-10-01T00:00:00+00:00", "2026-02-30T00:00:00Z", "not-an-instant"])(
    "requires a real ISO UTC Z instant (%#)",
    (instant) => expect(() => validateOperatorSessionInstant(instant)).toThrow("invalid-session-instant"),
  );

  it("accepts UTC instants with and without milliseconds", () => {
    expect(() => validateOperatorSessionInstant("2026-10-01T00:00:00Z")).not.toThrow();
    expect(() => validateOperatorSessionInstant("2026-10-01T00:00:00.123Z")).not.toThrow();
  });
});
