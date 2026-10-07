import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const installer = read("./install-ci.sh");
const workflow = parse(read("../../../.github/workflows/platform-pr.yml"));
const steps = workflow.jobs.static.steps;
const setup = steps.find((step) => step.name === "Install Chromium for zero-network provider boundary controls").run;
const cleanup = steps.find((step) => step.name === "Remove owned provider browser boundary").run;
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe" : "bash";
const prologue = installer.slice(0, installer.indexOf("readonly target="));
const setupPrologue = setup.slice(0, setup.indexOf("mark runner-identity"));
const cleanupPrologue = cleanup.slice(0, cleanup.indexOf("input="));

function shell(source, syntaxOnly = false) {
  // Only extracted diagnostics/guards run here, never installation or sudo.
  const result = spawnSync(bash, ["--noprofile", "--norc", syntaxOnly ? "-n" : "-s"], {
    input: source,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

it("AC-02 setup: installer, setup and cleanup have valid shell syntax", () => {
  for (const source of [installer, setup, cleanup])
    expect(shell(source, true)).toMatchObject({ status: 0, stderr: "" });
});

it("AC-02 setup: fixed source, native, profile, adapter and cleanup paths agree outside writable /opt", () => {
  const root = "/usr/local/lib/chase-sets-provider-window";
  expect(installer).toContain(`readonly target=${root}\n`);
  expect(read("./launcher.c")).toContain(`#define INSTALL "${root}"`);
  expect(read("./apparmor.profile")).toContain(
    `profile chase-sets-provider-window ${root}/launcher flags=(unconfined)`,
  );
  expect(read("../test-window-browser.mjs")).toContain(`export const BROWSER_LAUNCHER = "${root}/launcher"`);
  expect(read("../test-window-browser.test.mjs")).toContain(`${root}/root/tmp`);
  for (const source of [setup, cleanup]) expect(source).toContain(`input=${root}-input\n`);
  expect(cleanup).toContain(`require input-path test "$(realpath -e -- "$input")" = ${root}-input`);
  for (const source of [installer, setup]) {
    expect(source).toContain("for parent in / /usr /usr/local /usr/local/lib; do");
    expect(source).not.toContain("chmod 0755 /opt");
  }
  expect(steps[0].with["fetch-depth"]).toBe(0);
  expect(setup).toContain('require checkout-commit test "$(/usr/bin/git rev-parse HEAD)" = "$GITHUB_SHA"');
  expect(setup).toContain('/usr/bin/git cat-file -e "$GITHUB_SHA^{commit}"');
});

it("AC-02 setup: every literal refusing guard emits its own closed code without marker data", () => {
  for (const [source, prefix, diagnostic] of [
    [installer, prologue, "installer"],
    [setup, setupPrologue, "setup"],
    [cleanup, cleanupPrologue, "cleanup"],
  ]) {
    const codes = [...source.matchAll(/\brequire ([a-z][a-z-]+) /g)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const result = shell(`${prefix}\nprivate=SYNTHETIC_PRIVATE_MARKER\nrequire ${code} test "$private" = absent\n`);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`provider-boundary-${diagnostic}-refused:${code}`);
      expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    }
    // A future bare assertion could fail silently or hide behind the previous stage.
    expect(source).not.toMatch(/^\s*test /m);
    expect(source).not.toContain("then exit 1;");
  }
});

it("AC-02 setup: unknown command, pipeline and assignment failures retain the named stage", () => {
  for (const [prefix, diagnostic] of [
    [prologue, "installer"],
    [setupPrologue, "setup"],
    [cleanupPrologue, "cleanup"],
  ]) {
    for (const command of ["false", "false | true", 'value="$(false)"', "nested() { false; }; nested"]) {
      const result = shell(`${prefix}\nmark synthetic-command\n${command}\n`);
      expect(result).toEqual({
        status: 1,
        stdout: `provider-boundary-${diagnostic}-stage:synthetic-command`,
        stderr: `provider-boundary-${diagnostic}-refused:synthetic-command`,
      });
    }
    expect(shell(`${prefix}\nrequire synthetic-pass true\n`)).toEqual({ status: 0, stdout: "", stderr: "" });
  }
});

it("AC-02 setup: writable-parent refusal stays enforced, including the governing guard-omission mutant", () => {
  const guard = installer.match(/^  require parent-ownership .+$/m)?.[0];
  expect(guard).toBeDefined();
  const run = (identity, candidate = guard) =>
    shell(`${prologue}\nparent=/SYNTHETIC_PARENT\nstat() { printf '%s' '${identity}'; }\n${candidate}\n`);
  expect(run("0:755").status).toBe(0);
  for (const identity of ["0:777", "1001:755", "0:775", "0:4755"]) {
    expect(run(identity)).toMatchObject({ status: 1, stderr: "provider-boundary-installer-refused:parent-ownership" });
  }
  // Synthetic identity, not a substituted fact associated with the real job.
  expect(run("0:777", "true").status).toBe(0);
});

it("AC-02 setup: actual negative-result checks distinguish exit status and exact closed output", () => {
  const refusal = installer.slice(installer.indexOf("refusal() {"), installer.indexOf("# These are serialized"));
  for (const [status, output, expected] of [
    [78, "provider-boundary-refused:arguments", null],
    [0, "provider-boundary-refused:arguments", "negative-arguments-status"],
    [78, "SYNTHETIC_PRIVATE_MARKER", "negative-arguments-output"],
  ]) {
    const result = shell(
      `${prologue}\n${refusal}\nsynthetic() { printf '%s' '${output}'; return ${status}; }\nrefusal arguments synthetic\n`,
    );
    expect(result.status).toBe(expected ? 1 : 0);
    expect(result.stderr).toBe(expected ? `provider-boundary-installer-refused:${expected}` : "");
    expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_PRIVATE_MARKER");
  }
});

it("AC-02 setup: condition-6 real controls and the independent OS mutant remain installed", () => {
  for (const stage of [
    "arguments",
    "source-identity",
    "automation-pipes",
    "launcher-identity",
    "attachment",
    "dependency-identity",
    "principal",
    "external-interface",
  ]) {
    expect(installer).toMatch(new RegExp(`^refusal ${stage} `, "m"));
  }
  expect(installer).toContain(
    'refusal arguments runuser -u "$principal" -- "$target/launcher" /bin/sh "$source_digest"',
  );
  expect(installer).toContain(
    'refusal arguments runuser -u "$principal" -- "$target/launcher" browser "$source_digest" --no-sandbox',
  );
  expect(installer).toContain('"$target/unprofiled-comparison" probe "$source_digest"');
  expect(installer).toContain('"$target/wrong.profile"');
  expect(installer).toContain("refuse missing-installation-accepted");
  expect(installer).toContain("refuse disallowed-principal-accepted");
  expect(installer).toContain("sed 's/unshare(CLONE_NEWNET | CLONE_NEWNS/unshare(CLONE_NEWNS/'");
  expect(installer).toContain("require os-mutant-predicate");
  expect(installer).toContain("mark admission-probe\nprobe\n");
});
