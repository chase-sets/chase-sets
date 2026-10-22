import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { errors } from "@playwright/test";
import {
  ADMISSION,
  TRANSITION,
  admissionProof,
  mediationFailure,
  mediationDiagnostic,
  launchDiagnostic,
  nativeRefusal,
  observerDiagnostic,
  browserCapabilityProof,
  removalRefusal,
  removalWitness,
} from "./protocol.mjs";

const launchRefusalMessage = [
  "browserType.launch: failed details are ignored",
  "  - <launched> pid=42",
  "  - [pid=42][err] provider-boundary-refused:source-identity",
  "  - [pid=42] <process did exit: exitCode=78, signal=null>",
].join("\n");
const plainLaunchRefusalMessage = launchRefusalMessage
  .split("\n")
  .map((line, index) => (index === 0 ? line : line.slice(4)))
  .join("\n");

it("AC1 classifies one PID launch refusal and binds native refusal payloads", () => {
  expect(launchDiagnostic({ message: launchRefusalMessage })).toEqual({
    version: 1,
    class: "exited",
    window: "from-launch",
    exitCode: 78,
    exitSignal: null,
    refusal: "source-identity",
  });
});

it("AC1 accepts nested-sandbox output and maps unknown signals to other", () => {
  const message = [
    "<launched> pid=7",
    `[pid=7][out] ${TRANSITION.trimEnd()}`,
    "[pid=7][err] provider-boundary-refused:seed-reap",
    "[pid=7][err] provider-boundary-refused:nested-sandbox",
    "[pid=7] <process did exit: exitCode=78, signal=SIGCHLD>",
  ].join("\n");
  expect(launchDiagnostic({ message })).toMatchObject({
    class: "exited",
    window: "from-launch",
    exitCode: 78,
    exitSignal: "other",
    refusal: "seed-reap",
  });
});

it.each([
  [
    "same-PID conflicting exit",
    `${launchRefusalMessage}\n[pid=42] <process did exit: exitCode=0, signal=null>`,
    {
      version: 1,
      class: "unknown",
      window: "from-launch",
      exitCode: null,
      exitSignal: null,
      refusal: null,
    },
  ],
  [
    "non-78 exit",
    launchRefusalMessage.replace("exitCode=78", "exitCode=1"),
    {
      version: 1,
      class: "exited",
      window: "from-launch",
      exitCode: 1,
      exitSignal: null,
      refusal: null,
    },
  ],
  [
    "no exit",
    launchRefusalMessage.replace(/\n  - \[pid=42\] <process did exit:.*$/, ""),
    {
      version: 1,
      class: "unknown",
      window: "from-launch",
      exitCode: null,
      exitSignal: null,
      refusal: null,
    },
  ],
  [
    "out-of-range exit",
    launchRefusalMessage.replace("exitCode=78", "exitCode=256"),
    {
      version: 1,
      class: "exited",
      window: "from-launch",
      exitCode: null,
      exitSignal: null,
      refusal: null,
    },
  ],
  [
    "allowlisted signal",
    launchRefusalMessage.replace("signal=null", "signal=SIGKILL"),
    {
      version: 1,
      class: "exited",
      window: "from-launch",
      exitCode: 78,
      exitSignal: "SIGKILL",
      refusal: "source-identity",
    },
  ],
  [
    "unknown signal",
    launchRefusalMessage.replace("signal=null", "signal=SIGCHLD"),
    {
      version: 1,
      class: "exited",
      window: "from-launch",
      exitCode: 78,
      exitSignal: "other",
      refusal: "source-identity",
    },
  ],
  [
    "ANSI exit line",
    launchRefusalMessage.replace(
      "[pid=42] <process did exit: exitCode=78, signal=null>",
      "\u001b[2m[pid=42] <process did exit: exitCode=78, signal=null>\u001b[22m",
    ),
    {
      version: 1,
      class: "unknown",
      window: "from-launch",
      exitCode: null,
      exitSignal: null,
      refusal: null,
    },
  ],
  [
    "plain and call-log duplicates",
    plainLaunchRefusalMessage
      .split("\n")
      .flatMap((line) => [line, `  - ${line}`])
      .join("\n"),
    {
      version: 1,
      class: "exited",
      window: "from-launch",
      exitCode: 78,
      exitSignal: null,
      refusal: "source-identity",
    },
  ],
  [
    "double call-log prefix",
    plainLaunchRefusalMessage
      .split("\n")
      .map((line) => `  -   - ${line}`)
      .join("\n"),
    {
      version: 1,
      class: "unknown",
      window: "partial",
      exitCode: null,
      exitSignal: null,
      refusal: null,
    },
  ],
  [
    "drifted exit format",
    launchRefusalMessage.replace("exitCode=78, signal=null", "exitCode=78 signal=null"),
    {
      version: 1,
      class: "unknown",
      window: "from-launch",
      exitCode: null,
      exitSignal: null,
      refusal: null,
    },
  ],
  [
    "evicted launch line",
    launchRefusalMessage.replace("  - <launched> pid=42\n", ""),
    {
      version: 1,
      class: "exited",
      window: "partial",
      exitCode: 78,
      exitSignal: null,
      refusal: "source-identity",
    },
  ],
  [
    "spawn failure",
    "Failed to launch: marker",
    {
      version: 1,
      class: "spawn-failed",
      window: "partial",
      exitCode: null,
      exitSignal: null,
      refusal: null,
    },
  ],
  [
    "prefixed spawn failure",
    "browserType.launch: Failed to launch: marker\n<launched> pid=1",
    {
      version: 1,
      class: "spawn-failed",
      window: "from-launch",
      exitCode: null,
      exitSignal: null,
      refusal: null,
    },
  ],
  [
    "multiple PIDs",
    "[pid=1] <process did exit: exitCode=78, signal=null>\n[pid=2] <process did exit: exitCode=78, signal=null>",
    {
      version: 1,
      class: "unknown",
      window: "partial",
      exitCode: null,
      exitSignal: null,
      refusal: null,
    },
  ],
  [
    "refusal without exit",
    "[pid=1][err] provider-boundary-refused:source-identity",
    {
      version: 1,
      class: "unknown",
      window: "partial",
      exitCode: null,
      exitSignal: null,
      refusal: null,
    },
  ],
])("AC1 named launch state %#", (_name, message, expected) => {
  expect(launchDiagnostic({ message })).toEqual(expected);
});

it("AC1 timeout uses the Playwright TimeoutError class", () => {
  const error = new errors.TimeoutError("PRIVATE marker");
  expect(launchDiagnostic(error, error instanceof errors.TimeoutError)).toEqual({
    version: 1,
    class: "timeout",
    window: "partial",
    exitCode: null,
    exitSignal: null,
    refusal: null,
  });
});

it("AC2 M-unbound-refusal and M-raw fail executable named negatives", () => {
  const non78 = launchDiagnostic({ message: launchRefusalMessage.replace("exitCode=78", "exitCode=1") });
  expect(non78).toMatchObject({ class: "exited", exitCode: 1, refusal: null });

  const noExit = launchDiagnostic({
    message: launchRefusalMessage.replace(/\n  - \[pid=42\] <process did exit:.*$/, ""),
  });
  expect(noExit).toMatchObject({ class: "unknown", exitCode: null, refusal: null });

  const marker = "SYNTHETIC_PRIVATE_MARKER";
  const payload = launchDiagnostic({
    message: [
      "<launched> pid=42",
      `[pid=42][out] ${marker}`,
      `[pid=42][err] ${marker}`,
      "[pid=42] <process did exit: exitCode=78, signal=null>",
    ].join("\n"),
  });
  expect(payload).toMatchObject({ class: "exited", exitCode: 78, refusal: null });
});

it("AC3 drops markers and keeps the structured record bounded", () => {
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  const failure = mediationFailure("sandboxed-chromium", {
    message: `${marker}\n${launchRefusalMessage}\n${marker}`,
    stack: marker,
    code: 78,
    stdout: marker,
    stderr: marker,
  });
  expect(failure.message).not.toContain(marker);
  expect(Buffer.byteLength(failure.message, "utf8")).toBeLessThanOrEqual(512);
  expect(JSON.stringify(mediationDiagnostic(failure))).not.toContain(marker);
  const payloadFailure = mediationFailure("sandboxed-chromium", {
    message: [
      "<launched> pid=42",
      `[pid=42][out] ${marker}`,
      `[pid=42][err] ${marker}`,
      "[pid=42] <process did exit: exitCode=78, signal=null>",
    ].join("\n"),
  });
  expect(mediationDiagnostic(payloadFailure).launch).toMatchObject({
    class: "exited",
    exitCode: 78,
    refusal: null,
  });
  expect(payloadFailure.message).not.toContain(marker);
  expect(JSON.stringify(mediationDiagnostic(payloadFailure))).not.toContain(marker);
  expect(mediationDiagnostic(mediationFailure("installed-boundary", { message: marker })).launch).toBeUndefined();
});

it("AC3 preserves the byte-stable non-launch failure envelope", () => {
  const failure = mediationFailure("installed-boundary", {
    code: 78,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("provider-boundary-refused:source-identity\n"),
  });
  expect(failure.message).toBe(
    'browser-mediation-unavailable: {"stage":"installed-boundary","status":78,"signal":null,"nativeStage":"source-identity","stdoutBytes":0,"stderrBytes":42,"redacted":true,"truncated":false,"complete":true,"userNamespaceRestriction":"unknown"}',
  );
});

const dropped = {
  image: "chrome",
  userNamespace: "launch",
  rootObservation: "path-checked",
  NoNewPrivs: "1",
  CapInh: "0000000000000000",
  CapPrm: "0000000000000000",
  CapEff: "0000000000000000",
  CapBnd: "0000000000000000",
  CapAmb: "0000000000000000",
};
const scoped = {
  ...dropped,
  userNamespace: "nested",
  rootObservation: "private-proc-fdinfo",
  CapPrm: "0000000000200000",
  CapEff: "0000000000200000",
  CapBnd: "000001ffffffffff",
};

const liveRemoval = {
  code: 1,
  signal: null,
  stdout:
    "provider-boundary-cleanup-stage:remove-installation\nprovider-boundary-installer-stage:source-location\nprovider-boundary-installer-stage:remove-ownership\nprovider-boundary-cleanup-installer-status:1\n",
  stderr:
    "provider-boundary-installer-refused:remove-live-owner\nprovider-boundary-cleanup-refused:remove-installation\n",
};
const driftWitness =
  "provider-boundary-removal-witness:v1;predicate=identity-drift;records=20,1,100,2,3,initial,other,other|20,1,100,2,4,initial,other,other;start-drift=0;image-drift=1;repeated-pid=0;chain-length=0\n";

it("SYNTHETIC closed witness grammar agrees with the helper without lossy numeric conversion", () => {
  const good = [
    driftWitness,
    driftWitness.replace("2,4,initial,other,other", "-,-,initial,other,none"),
    driftWitness.replace("2,3,initial,other,other", "-,-,initial,other,none"),
    driftWitness
      .replaceAll(",100,", ",18446744073709551615,")
      .replace("2,4,", "18446744073709551615,18446744073709551615,"),
    "provider-boundary-removal-witness:v1;predicate=parent-order;records=21,20,99,1,2,initial,admitted,launcher|20,1,100,1,2,initial,admitted,launcher;start-drift=0;image-drift=0;repeated-pid=0;chain-length=0\n",
    "provider-boundary-removal-witness:v1;predicate=foreign-image;records=20,1,100,1,3,initial,admitted,target;start-drift=0;image-drift=0;repeated-pid=0;chain-length=0\n",
    "provider-boundary-removal-witness:v1;predicate=member-cycle;records=20,21,100,1,2,noninitial,admitted,launcher;start-drift=0;image-drift=0;repeated-pid=20;chain-length=4096\n",
  ];
  const bad = [
    "",
    driftWitness.trimEnd(),
    driftWitness + "\n",
    driftWitness + driftWitness,
    "PRIVATE" + driftWitness,
    driftWitness + "PRIVATE",
    driftWitness.replace("v1;", "v2;"),
    driftWitness.replace("records=20", "records=020"),
    driftWitness.replace("records=20", "records=2147483648"),
    driftWitness.replace("records=20", "records=0"),
    driftWitness.replace(",100,", ",18446744073709551616,"),
    driftWitness.replace(",100,", ",1e2,"),
    driftWitness.replace(",100,", ",-1,"),
    driftWitness.replace("image-drift=1", "image-drift=0"),
    driftWitness.replace("start-drift=0", "start-drift=1"),
    driftWitness.replace("|20,", "|21,"),
    driftWitness.replace("initial", "PRIVATE"),
    driftWitness.replace("other,other", "other,none"),
    driftWitness.replace("repeated-pid=0", "repeated-pid=20"),
    driftWitness.replace("chain-length=0", "chain-length=1"),
    driftWitness.replace(";start-drift", ";extra=PRIVATE;start-drift"),
    driftWitness.replace(";start-drift", ";records=20;start-drift"),
    driftWitness.replace("\n", "\r\n"),
    driftWitness.replace("v1", "v\u00b1"),
    driftWitness.replace("v1", "v\0"),
    "x".repeat(1025),
    good[4].replace("21,20,99", "21,20,101"),
    good[4].replace("21,20,99", "21,19,99"),
    good[5].replace("initial", "noninitial"),
    good[5].replace("target", "other"),
    good[6].replace("4096", "4097"),
    good[6].replace("4096", "0"),
    good[6].replace("repeated-pid=20", "repeated-pid=21"),
    driftWitness.replace(";start-drift", "|20,1,100,2,4,initial,other,other;start-drift"),
  ];
  const lines = [...good, ...bad];
  const expected = lines.map((_, index) => index < good.length);
  expect(lines.map((line) => removalWitness(line) === line && line !== "")).toEqual(expected);
  const helper = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-B",
      "-c",
      "import json,sys; sys.path.insert(0,sys.argv[1]); import ownership; print(json.dumps([ownership.removal_witness(s.encode()) is not None for s in json.load(sys.stdin)]))",
      fileURLToPath(new URL(".", import.meta.url)),
    ],
    { input: JSON.stringify(lines), encoding: "utf8" },
  );
  expect(helper.status, helper.stderr).toBe(0);
  expect(JSON.parse(helper.stdout)).toEqual(expected);
});

it("SYNTHETIC whole I/W envelope requires witness validation even under populated ambient selectors", async () => {
  const actual = {
    ...liveRemoval,
    stderr: driftWitness + liveRemoval.stderr.replace("remove-live-owner", "remove-ambiguous-owner"),
  };
  for (const ambient of ["", "true"]) {
    vi.stubEnv("CI", ambient);
    vi.stubEnv("GITHUB_ACTIONS", ambient);
    vi.stubEnv("BOUNDARY_DIAGNOSTIC", ambient ? "13c-alone" : "");
    try {
      expect(removalRefusal(actual, "remove-ambiguous-owner")).toBe(true);
      for (const change of [
        { stderr: actual.stderr.replace(driftWitness, "") },
        { stderr: actual.stderr + driftWitness },
        { stderr: driftWitness + actual.stderr },
        { stderr: actual.stderr.replace("image-drift=1", "image-drift=0") },
        { stderr: actual.stderr + "PRIVATE" },
        { stdout: actual.stdout + "PRIVATE" },
        { stdout: actual.stdout.replace("installer-status:1", "installer-status:0") },
        { code: 0 },
        { code: 78 },
        { code: 137 },
        { signal: "SIGTERM" },
        { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
      ])
        expect(removalRefusal({ ...actual, ...change }, "remove-ambiguous-owner")).toBe(false);
      expect(removalRefusal({ ...liveRemoval, stderr: driftWitness + liveRemoval.stderr }, "remove-live-owner")).toBe(
        false,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  }
  const source = readFileSync(new URL("protocol.mjs", import.meta.url), "utf8");
  const clause = "witness = removalWitness(stderr.subarray(0, end + 1));";
  expect(source.split(clause)).toHaveLength(2);
  const bypass = await import(
    `data:text/javascript;base64,${Buffer.from(
      source.replace(clause, 'witness = stderr.subarray(0, end + 1).toString("ascii");'),
    ).toString("base64")}`
  );
  const malformed = { ...actual, stderr: actual.stderr.replace("image-drift=1", "image-drift=0") };
  expect(removalRefusal(malformed, "remove-ambiguous-owner")).toBe(false);
  expect(bypass.removalRefusal(malformed, "remove-ambiguous-owner")).toBe(true);
});
it("control 13b compares both emitters' complete bytes with installer/wrapper status 1", () => {
  expect(removalRefusal(liveRemoval, "remove-live-owner")).toBe(true);
  for (const changed of [
    { code: 0 },
    { code: 78 },
    { code: 143 },
    { signal: "SIGKILL" },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    { stdout: "" },
    { stderr: "" },
    { stderr: liveRemoval.stderr + "PRIVATE" },
    { stdout: liveRemoval.stdout + "PRIVATE" },
    { stderr: liveRemoval.stderr.replace("remove-live-owner", "remove-orphan-owner") },
    { stdout: liveRemoval.stdout + "provider-boundary-installer-stage:remove-profile\n" },
    { stdout: liveRemoval.stdout.replace("installer-status:1", "installer-status:78") },
    { stdout: liveRemoval.stdout.replace("installer-status:1", "installer-status:137") },
    { stdout: liveRemoval.stdout.replace("provider-boundary-cleanup-installer-status:1\n", "") },
  ])
    expect(removalRefusal({ ...liveRemoval, ...changed }, "remove-live-owner")).toBe(false);
});

it("control 13d requires its own census refusal, not live-owner or an open stage", () => {
  const missingKey = {
    ...liveRemoval,
    stderr: liveRemoval.stderr.replace("remove-live-owner", "remove-ownership-census"),
  };
  expect(removalRefusal(missingKey, "remove-ownership-census")).toBe(true);
  expect(removalRefusal(liveRemoval, "remove-ownership-census")).toBe(false);
  expect(removalRefusal(missingKey, "remove-live-owner")).toBe(false);
  expect(removalRefusal(missingKey, "PRIVATE")).toBe(false);
});

it.each(["remove-orphan-owner", "remove-ambiguous-owner"])(
  "common ownership proof preserves exact stage and emitter statuses: %s",
  (stage) => {
    const actual = {
      ...liveRemoval,
      stderr:
        (stage === "remove-ambiguous-owner" ? driftWitness : "") +
        liveRemoval.stderr.replace("remove-live-owner", stage),
    };
    expect(removalRefusal(actual, stage)).toBe(true);
    expect(removalRefusal(actual, "remove-live-owner")).toBe(false);
    expect(removalRefusal({ ...actual, code: 78 }, stage)).toBe(false);
    expect(removalRefusal({ ...actual, stdout: actual.stdout + "PRIVATE" }, stage)).toBe(false);
  },
);

it("control 13c exact orphan refusal remains 198/110 bytes; bare ambiguity is now unknown", () => {
  const orphan = { ...liveRemoval, stderr: liveRemoval.stderr.replace("remove-live-owner", "remove-orphan-owner") };
  const ambiguous = {
    ...liveRemoval,
    stderr: liveRemoval.stderr.replace("remove-live-owner", "remove-ambiguous-owner"),
  };
  expect([Buffer.byteLength(orphan.stdout), Buffer.byteLength(orphan.stderr)]).toEqual([198, 110]);
  expect([Buffer.byteLength(ambiguous.stdout), Buffer.byteLength(ambiguous.stderr)]).toEqual([198, 113]);
  expect(removalRefusal(orphan, "remove-orphan-owner")).toBe(true);
  expect(removalRefusal(ambiguous, "remove-orphan-owner")).toBe(false);
  expect(removalRefusal(ambiguous, "remove-ambiguous-owner")).toBe(false);
});

it("CP-B distinguishes dropped launch authority from proved nested sandbox authority", () => {
  expect(browserCapabilityProof(dropped)).toBe(true);
  expect(browserCapabilityProof(scoped)).toBe(true);
  expect(browserCapabilityProof({ ...scoped, CapPrm: dropped.CapPrm, CapEff: dropped.CapEff })).toBe(true);
});

it.each(["remove-target-symlink", "remove-target-path", "remove-profile-symlink", "input-not-symlink", "input-path"])(
  "R1 %s refuses before census and preserves its own emitter status",
  (stage) => {
    const input = stage.startsWith("input-");
    const actual = {
      code: 1,
      signal: null,
      stdout: input
        ? ""
        : "provider-boundary-cleanup-stage:remove-installation\nprovider-boundary-installer-stage:source-location\nprovider-boundary-cleanup-installer-status:1\n",
      stderr: input
        ? `provider-boundary-cleanup-refused:${stage}\n`
        : `provider-boundary-installer-refused:${stage}\nprovider-boundary-cleanup-refused:remove-installation\n`,
    };
    expect(removalRefusal(actual, stage)).toBe(true);
    for (const mutation of [
      { code: 0 },
      { code: 78 },
      { signal: "SIGTERM" },
      { stdout: actual.stdout + "provider-boundary-installer-stage:remove-ownership\n" },
      { stderr: actual.stderr + "SYNTHETIC_PRIVATE" },
    ])
      expect(removalRefusal({ ...actual, ...mutation }, stage)).toBe(false);
  },
);

it.each([
  { ...scoped, userNamespace: "launch" },
  { ...scoped, userNamespace: "host" },
  { ...scoped, userNamespace: "unrelated" },
  { ...scoped, userNamespace: undefined },
  { ...scoped, rootObservation: "path-checked" },
  { ...scoped, image: "launcher" },
  { ...scoped, CapEff: "000001ffffffffff", CapPrm: "000001ffffffffff" },
  { ...scoped, CapPrm: "0000000000240000" },
  { ...scoped, CapBnd: "0000000000000000" },
  { ...scoped, CapBnd: "000003ffffffffff" },
  { ...scoped, CapInh: "0000000000200000" },
  { ...scoped, CapAmb: "0000000000200000" },
  { ...scoped, NoNewPrivs: "0" },
])("CP-B refuses broadened, unbound or retained launch capabilities %#", (record) => {
  expect(browserCapabilityProof(record)).toBe(false);
});

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

const observerErrnos = ["none", "EACCES", "EPERM", "ENOENT", "ESRCH", "ENOTDIR", "ELOOP", "EIO", "other"];
const observerIdentities = ["same", "changed", "zombie", "gone", "unknown"];
const observerDetail = "provider-boundary-observer-refused:namespaces\nprovider-boundary-observer-detail:EACCES:same\n";

it.each(observerErrnos.flatMap((errno) => observerIdentities.map((identity) => ({ errno, identity }))))(
  "observer detail retains closed errno $errno and identity $identity",
  ({ errno, identity }) => {
    const stderr = `provider-boundary-observer-refused:namespaces\nprovider-boundary-observer-detail:${errno}:${identity}\n`;
    expect(observerDiagnostic({ code: 1, stdout: "", stderr })).toMatchObject({
      stage: "namespaces",
      errno,
      identity,
      root: null,
      redacted: true,
    });
  },
);

it.each([
  "arguments",
  "census",
  "descendants",
  "status",
  "status-field",
  "label",
  "namespaces",
  "user-namespace",
  "identity-recheck",
])("observer preserves stage-only and detailed refusals at %s", (stage) => {
  const stderr = `provider-boundary-observer-refused:${stage}\n`;
  expect(observerDiagnostic({ code: 1, stdout: "", stderr })).toMatchObject({
    stage,
    errno: "unknown",
    identity: "unknown",
  });
  expect(
    observerDiagnostic({ code: 1, stdout: "", stderr: stderr + "provider-boundary-observer-detail:none:unknown\n" }),
  ).toMatchObject({ stage, errno: "none", identity: "unknown" });
});

it.each([
  { code: 78, stdout: "", stderr: observerDetail },
  { code: 1, signal: "SIGTERM", stdout: "", stderr: observerDetail },
  { code: 1, stdout: "PRIVATE", stderr: observerDetail },
  ...[
    observerDetail + "PRIVATE",
    observerDetail + "\n",
    observerDetail + observerDetail,
    observerDetail.slice(0, -1),
    observerDetail.replaceAll("\n", "\r\n"),
    observerDetail.replace("namespaces", "PRIVATE"),
    observerDetail.replace("EACCES", "PRIVATE"),
    observerDetail.replace("same", "PRIVATE"),
    observerDetail.replace("namespaces", "root"),
    "x".repeat(513),
    Buffer.concat([Buffer.from(observerDetail), Buffer.from([0xff])]),
    Buffer.from(observerDetail).map((byte) => byte | 0x80),
    Buffer.from(observerDetail.replace("same", "s\u00e1me")),
  ].map((stderr) => ({ code: 1, stdout: "", stderr })),
  { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "", stderr: observerDetail },
])("observer detail rejects contaminated, oversized or untrusted capture %#", (error) => {
  const result = observerDiagnostic(error);
  expect(result).toMatchObject({ stage: "unknown", errno: "unknown", identity: "unknown", root: null });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

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
