import { expect, it } from "vitest";
import {
  ADMISSION,
  TRANSITION,
  admissionProof,
  mediationFailure,
  mediationDiagnostic,
  nativeRefusal,
  observerDiagnostic,
} from "./protocol.mjs";

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

it("hosted diagnostics require provenance, not an error message that impersonates closed JSON", () => {
  const failure = mediationFailure("SYNTHETIC_PRIVATE_STAGE", { stdout: "", stderr: "PRIVATE", code: 78 });
  expect(mediationDiagnostic(failure).stage).toBe("unknown");
  expect(JSON.stringify(mediationDiagnostic(failure))).not.toContain("PRIVATE");
  expect(mediationDiagnostic(new Error(failure.message))).toBeNull();
  expect(mediationDiagnostic({ diagnostic: { stage: "PRIVATE" } })).toBeNull();
});

it("observer status 1, native status 78, signal, and contaminated output remain distinct", () => {
  const stderr = "provider-boundary-observer-refused:census\n";
  expect(observerDiagnostic({ code: 1, stdout: "", stderr }).stage).toBe("census");
  expect(observerDiagnostic({ code: 1, stdout: "PRIVATE", stderr }).stage).toBe("unknown");
  expect(observerDiagnostic({ code: 78, stderr }).stage).toBe("unknown");
  expect(observerDiagnostic({ code: 1, stderr: stderr + "PRIVATE" }).stage).toBe("unknown");
  expect(observerDiagnostic({ signal: "SIGTERM", stderr: "" })).toMatchObject({
    status: null,
    signal: "SIGTERM",
    stage: "unknown",
  });
  expect(JSON.stringify(observerDiagnostic({ code: 1, stderr: "PRIVATE" }))).not.toContain("PRIVATE");
});

const rootRefusal =
  "provider-boundary-observer-refused:root\nprovider-boundary-observer-root:20:1:100:1:2:chrome:host-helper:EACCES:same:proc-fdinfo:directory:none\n";

it("observer root diagnostics retain only emitter-owned closed process/image, path kind and errno", () => {
  expect(observerDiagnostic({ code: 1, stdout: "", stderr: rootRefusal })).toMatchObject({
    stage: "root",
    root: {
      pid: 20,
      parent: 1,
      start: 100,
      imageDevice: 1,
      imageInode: 2,
      image: "chrome",
      pathKind: "host-helper",
      errno: "EACCES",
      identityRecheck: "same",
      rootLink: "proc-fdinfo",
      rootKind: "directory",
      rootErrno: "none",
    },
    status: 1,
    redacted: true,
    truncated: false,
  });
});

it.each([
  { code: 78, stdout: "", stderr: rootRefusal },
  { code: 1, signal: "SIGTERM", stdout: "", stderr: rootRefusal },
  { code: 1, stdout: "PRIVATE", stderr: rootRefusal },
  { code: 1, stdout: "", stderr: rootRefusal + "PRIVATE" },
  { code: 1, stdout: "", stderr: rootRefusal + "\n" },
  { code: 1, stdout: "", stderr: rootRefusal.replace(":20:", ":9007199254740992:") },
  { code: 1, stdout: "", stderr: rootRefusal.replace("chrome", "PRIVATE") },
  { code: 1, stdout: "", stderr: rootRefusal.replace("host-helper", "PRIVATE") },
  { code: 1, stdout: "", stderr: rootRefusal.replace("EACCES", "PRIVATE") },
  { code: 1, stdout: "", stderr: rootRefusal.replace("same", "PRIVATE") },
  { code: 1, stdout: "", stderr: rootRefusal.replace("proc-fdinfo", "PRIVATE") },
  { code: 1, stdout: "", stderr: Buffer.concat([Buffer.from(rootRefusal), Buffer.from([0xff])]) },
  { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "", stderr: rootRefusal },
])("observer root output rejects wrong status, truncation, markers and unsafe fields %#", (error) => {
  const result = observerDiagnostic(error);
  expect(result.stage).toBe("unknown");
  expect(result.root).toBeNull();
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});
