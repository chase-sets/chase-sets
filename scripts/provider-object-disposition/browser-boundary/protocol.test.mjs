import { expect, it } from "vitest";
import { ADMISSION, TRANSITION, admissionProof, mediationFailure, nativeRefusal } from "./protocol.mjs";

it("CP-T precedes CP-A, with complete exact bytes and empty stderr", () => {
  expect(admissionProof(Buffer.from(TRANSITION + ADMISSION), Buffer.alloc(0))).toBe(true);
});

it.each([
  "",
  ADMISSION,
  TRANSITION,
  ADMISSION + TRANSITION,
  TRANSITION + ADMISSION + "\n",
  TRANSITION + ADMISSION.trimEnd(),
  TRANSITION + ADMISSION.replace("true", "false"),
  TRANSITION.replace('"seed":"reaped"', '"seed":{"state":"reaped"}') + ADMISSION,
  TRANSITION.replace('"seed":"reaped"', '"seed":"reaped","unknown":true') + ADMISSION,
  TRANSITION + ADMISSION.replace('"admitted":true', '"admitted":true,"admitted":true'),
  TRANSITION + ADMISSION.replace('"handles":"closed"', '"handles":"closed","time":"2026-10-07"'),
  TRANSITION + ADMISSION.replace('"handles":"closed"', '"handles":"closed","count":129'),
])("control 19 rejects incomplete, reordered, expanded or malformed proof %#", (output) => {
  expect(admissionProof(output, "")).toBe(false);
});

it.each(["SYNTHETIC_PRIVATE_MARKER\n", "\n", Buffer.from([0xff])])(
  "stderr never inherits a successful status %#",
  (stderr) => {
    expect(admissionProof(TRANSITION + ADMISSION, stderr)).toBe(false);
  },
);

it.each(["namespace-seed", "seed-deadline", "seed-reap", "namespace-identity", "mapping-identity"])(
  "native status and complete literal are retained: %s",
  (stage) => {
    const stderr = `provider-boundary-refused:${stage}\n`;
    expect(nativeRefusal("", stderr, 78)).toBe(stage);
    expect(nativeRefusal(TRANSITION, stderr + "provider-boundary-refused:nested-sandbox\n", 78)).toBe(stage);
    expect(nativeRefusal("", stderr, 1)).toBeNull();
    expect(nativeRefusal("", stderr, 143)).toBeNull();
    expect(nativeRefusal("", stderr + "PRIVATE", 78)).toBeNull();
    expect(nativeRefusal("", stderr.trimEnd(), 78)).toBeNull();
  },
);

it.each([
  { code: 78, stdout: TRANSITION, stderr: "provider-boundary-refused:external-interface\nPRIVATE" },
  { code: 78, stdout: "", stderr: "provider-boundary-refused:unknown\n" },
  { code: 78, stdout: "", stderr: "provider-boundary-refused:seed-reap\n".repeat(200) },
  { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "x".repeat(4097), stderr: "PRIVATE" },
  { code: null, signal: "SIGKILL", stdout: "", stderr: "" },
  { code: 143, signal: null, stdout: "", stderr: "" },
  {},
])("AC-B3/control 20 diagnostics cannot disclose unknown bytes or invent a native refusal %#", (error) => {
  const result = mediationFailure("installed-boundary", { message: "PRIVATE", ...error });
  expect(result.message).not.toContain("PRIVATE");
  expect(result.cause).toBeUndefined();
  const fields = JSON.parse(result.message.slice("browser-mediation-unavailable: ".length));
  expect(fields.redacted).toBe(true);
  expect(fields.nativeStage).toBeNull();
  expect(fields.truncated).toBe(error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(fields.stderrBytes).toBe(typeof error.stderr === "string" ? Buffer.byteLength(error.stderr) : null);
  expect(fields.complete).toBe(
    typeof error.stdout === "string" && typeof error.stderr === "string" && !fields.truncated,
  );
});

it("AC-B3 governing mutant compares original status/bytes, not a substring", () => {
  const stderr = "provider-boundary-refused:external-interface\n";
  expect(nativeRefusal(TRANSITION, stderr, 78)).toBe("external-interface");
  expect(nativeRefusal(TRANSITION + ADMISSION, stderr, 78)).toBeNull();
  expect(nativeRefusal(TRANSITION, stderr.replace("external-interface", "host-rejoin"), 78)).toBe("host-rejoin");
});
