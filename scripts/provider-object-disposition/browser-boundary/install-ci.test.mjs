import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SOURCE_FILES } from "../test-window-browser.mjs";
import { removalRefusal } from "./protocol.mjs";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const launcher = read("launcher.c");
const installer = read("install-ci.sh");

it("SYNTHETIC shipped I/W capture validates whole output and retains all resources on every refusal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "SYNTHETIC-removal-witness-"));
  const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
  // Rebind fixed paths only in an owned fixture copy; production has no overrides.
  const shellPath = (value) =>
    process.platform === "win32"
      ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
      : value;
  const input = path.join(root, "input");
  const source = path.join(input, "scripts/provider-object-disposition/browser-boundary");
  const target = path.join(root, "target");
  const profile = path.join(root, "profile");
  const effects = path.join(root, "effects");
  const quote = (value) => `'${shellPath(value).replaceAll("'", "'\\''")}'`;
  const witness =
    "provider-boundary-removal-witness:v1;predicate=foreign-image;records=20,1,100,1,3,initial,admitted,target;start-drift=0;image-drift=0;repeated-pid=0;chain-length=0\n";
  const ambiguous = "remove-ambiguous-owner\n" + witness;
  const python = process.platform === "win32" ? "python" : "python3";
  const bindings = [
    ["/usr/local/lib/chase-sets-provider-window-input", shellPath(input)],
    ["/usr/local/lib/chase-sets-provider-window", shellPath(target)],
    ["/etc/apparmor.d/chase-sets-provider-window", shellPath(profile)],
  ];
  const bind = (text) => bindings.reduce((result, [from, to]) => result.replaceAll(from, to), text);
  const cases = [
    [ambiguous, "", 1, "remove-ambiguous-owner"],
    ["", ambiguous, 1, "remove-ambiguous-owner"],
    ["remove-live-owner\n", "", 1, "remove-live-owner"],
    ["remove-orphan-owner\n", "", 1, "remove-orphan-owner"],
    ["remove-ownership-census\n", "", 1, "remove-ownership-census"],
    ["remove-ambiguous-owner\n", "", 1, "remove-ownership-census"],
    [ambiguous + witness, "", 1, "remove-ownership-census"],
    [ambiguous.slice(0, -1), "", 1, "remove-ownership-census"],
    [ambiguous, "SYNTHETIC_PRIVATE", 1, "remove-ownership-census"],
    [ambiguous + "\0", "", 1, "remove-ownership-census"],
    [ambiguous.replace("chain-length=0", "chain-length=1"), "", 1, "remove-ownership-census"],
    ["x".repeat(2048), "", 1, "remove-ownership-census"],
    [ambiguous, "", 0, "remove-ownership-census"],
    [ambiguous, "", 78, "remove-ownership-census"],
    [ambiguous, "", 137, "remove-ownership-census"],
    ["none\n", "", 1, "remove-ownership-census"],
    ["none\nPRIVATE", "", 0, "remove-ownership-census"],
    ["none\n\n", "", 0, "remove-ownership-census"],
  ];
  try {
    mkdirSync(source, { recursive: true });
    mkdirSync(target);
    writeFileSync(profile, "SYNTHETIC_PROFILE");
    // Match Linux stream framing in the Windows-only local shell fixture too.
    writeFileSync(
      path.join(source, "ownership.py"),
      "import sys; sys.stdout.reconfigure(newline='\\n')\n" + read("ownership.py"),
    );
    let script = bind(installer).replaceAll("/usr/bin/python3", python);
    script = script.replace(
      "set -Eeuo pipefail",
      `set -Eeuo pipefail
id() { printf '0\\n'; }
timeout() { cat ${quote(path.join(root, "stdout"))}; cat ${quote(path.join(root, "stderr"))} >&2; return "$(cat ${quote(path.join(root, "status"))})"; }
rm() { printf 'SYNTHETIC_DELETE\\n' >> ${quote(effects)}; return 91; }
`,
    );
    writeFileSync(path.join(source, "install-ci.sh"), script);
    const cleanup = bind(read("ci-cleanup.sh")).replace(
      "set -Eeuo pipefail",
      `set -Eeuo pipefail
sudo() {
  if test "$1" = env; then shift 4; /bin/bash "$@"; else printf 'SYNTHETIC_DELETE\\n' >> ${quote(effects)}; return 92; fi
}
`,
    );
    const cleanupPath = path.join(root, "cleanup.sh");
    writeFileSync(cleanupPath, cleanup);
    for (const [stdout, stderr, status, stage] of cases) {
      writeFileSync(path.join(root, "stdout"), stdout);
      writeFileSync(path.join(root, "stderr"), stderr);
      writeFileSync(path.join(root, "status"), String(status));
      const actual = spawnSync(shell, [shellPath(cleanupPath)], { encoding: "buffer" });
      expect(actual.error).toBeUndefined();
      expect(
        removalRefusal(
          { code: actual.status, signal: actual.signal, stdout: actual.stdout, stderr: actual.stderr },
          stage,
        ),
        JSON.stringify({ status, stage, out: actual.stdout.toString(), err: actual.stderr.toString() }),
      ).toBe(true);
      expect(existsSync(target) && existsSync(profile) && existsSync(input)).toBe(true);
      expect(existsSync(effects)).toBe(false);
    }
  } finally {
    // root is the exact create-only fixture returned by mkdtemp, never a source path.
    rmSync(root, { recursive: true, force: true });
  }
});

it("source identity inventory is shared by setup and admission", () => {
  const sources = /^sources=\(([^)]+)\)$/m.exec(installer)[1].split(" ");
  expect(sources).toEqual(SOURCE_FILES);
  for (const source of sources)
    expect(readFileSync(new URL(`../${source}`, import.meta.url)).length).toBeGreaterThan(0);
});

it("B-prime has no self-map fallback; SF precedes dumpability", () => {
  expect(launcher).not.toContain("unshare(CLONE_NEWUSER)");
  expect(launcher).not.toContain("chroot(");
  expect(launcher).toContain('syscall(SYS_pivot_root, ".", "old-root")');
  expect(launcher).toContain('umount2("/old-root", MNT_DETACH)');
  const seed = launcher.slice(launcher.indexOf("static void seed_main"), launcher.indexOf("static void seed_map"));
  expect(seed.indexOf("SYS_close_range")).toBeLessThan(seed.indexOf("seed_fence();"));
  expect(seed.indexOf("seed_fence();")).toBeLessThan(seed.indexOf("PR_SET_DUMPABLE"));
  expect(launcher).toContain("AUDIT_ARCH_X86_64");
  expect(launcher).toContain("0x40000000");
  expect(launcher).toContain("SECCOMP_RET_KILL_PROCESS");
});

it("outer/nested protocol retains only named handles with finite, distinct budgets", () => {
  expect(launcher).toContain("join_seed(false)");
  expect(launcher).toContain("join_seed(true)");
  expect(launcher).toContain("monotonic_ms() - started < 1000");
  expect(launcher).toContain("poll(&dead, 1, 250)");
  expect(launcher).toContain("monotonic_ms() - started < 1500");
  expect(launcher).toContain("if (parent >= 0) close(parent)");
  expect(launcher).toContain("close(seedfd)");
  expect(launcher).toContain("close(user)");
  expect(launcher.match(/unshare\(CLONE_NEWNET \| CLONE_NEWNS/g)).toHaveLength(1);
});

it("R1 and complete R2 precede any exact-name R3 deletion", () => {
  const remove = installer.slice(
    installer.indexOf("remove_installation()"),
    installer.indexOf('if test "$1" = remove'),
  );
  expect(remove.indexOf("remove-target-symlink")).toBeLessThan(remove.indexOf("mark remove-ownership"));
  expect(remove.indexOf("remove-profile-symlink")).toBeLessThan(remove.indexOf("mark remove-ownership"));
  expect(remove.indexOf("refuse remove-ownership-census")).toBeLessThan(remove.indexOf("mark remove-profile"));
  expect(remove).not.toContain("kill ");
  expect(remove).not.toContain("find ");
  expect(remove).toContain('rm -rf -- "$target"');
});

it("every direct native probe has its own 5s plus 1s kill deadline", () => {
  const controls = installer.slice(installer.indexOf("direct_probe()"));
  expect(controls.match(/runuser/g)).toHaveLength(1);
  expect(controls).toContain("timeout --signal=TERM --kill-after=1s 5s runuser");
  expect(controls).toContain("negative-$expected_stage-deadline");
  expect(controls).toContain('result="${result%.}"');
  expect(controls).toContain('test "$status" = 78');
});

it("operator, root and administrator boundaries have no runtime privilege fallback", () => {
  expect(installer).toContain("RUNNER_ENVIRONMENT:-");
  expect(installer).toContain("runner-administrator runuser");
  expect(launcher).not.toContain('"--no-sandbox"');
  expect(launcher).not.toContain('"/usr/bin/sudo"');
  expect(launcher).toContain("prctl(PR_SET_DUMPABLE, 0)");
  expect(launcher).toContain("PR_SET_NO_NEW_PRIVS");
});

it("cleanup completion requires exact-name and loaded-profile absence after admitted removal", () => {
  const cleanup = read("ci-cleanup.sh");
  expect(cleanup.indexOf("input-not-symlink")).toBeLessThan(cleanup.indexOf("mark remove-installation"));
  expect(cleanup.indexOf("mark verify-exact-names")).toBeGreaterThan(cleanup.indexOf("mark remove-input"));
  expect(cleanup).toContain('installer_status="$?"');
  expect(cleanup).toContain('require remove-installation test "$installer_status" = 0');
  for (const name of ["target-absent", "profile-absent", "input-absent", "profile-census", "profile-present"]) {
    expect(cleanup.indexOf(name)).toBeGreaterThan(cleanup.indexOf("mark verify-exact-names"));
    expect(cleanup.indexOf(name)).toBeLessThan(cleanup.indexOf("mark complete"));
  }
});

it("native inputs remain exact-head while shared Static retains PR merge-ref provenance", () => {
  const setup = read("ci-setup.sh");
  expect(setup).toContain('git merge-base --is-ancestor "$BOUNDARY_HEAD_SHA" HEAD');
  expect(setup).toContain('git diff --quiet "$BOUNDARY_HEAD_SHA" --');
  expect(setup).toContain('git archive "$BOUNDARY_HEAD_SHA" --');
  expect(setup.indexOf("checkout-boundary-bytes")).toBeLessThan(setup.indexOf("mark create-input"));
  const workflow = read("../../../.github/workflows/platform-pr.yml");
  const job = workflow.slice(workflow.indexOf("  static:"), workflow.indexOf("  typecheck:"));
  expect(job).toContain("BOUNDARY_HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}");
  expect(job).not.toContain("          ref:");
});

it("required Static keeps the complete source gate and native matrix under unchanged job deadlines", () => {
  const workflow = read("../../../.github/workflows/platform-pr.yml");
  const source = workflow.slice(workflow.indexOf("  static-source:"), workflow.indexOf("  static:"));
  const native = workflow.slice(workflow.indexOf("  static:"), workflow.indexOf("  typecheck:"));
  for (const job of [source, native]) {
    expect(job).toContain("timeout-minutes: 20");
    expect(job).toContain("needs['change-scope'].outputs.static_required == 'true'");
    expect(job).not.toContain("continue-on-error");
  }
  expect(source).toContain("FORMAT_CHECK_SCOPE: full");
  expect(source).toContain("run: pnpm run verify:static");
  expect(native).toContain("needs: [change-scope, static-source]");
  expect(native).toContain("if: always() && needs['change-scope'].result == 'success'");
  expect(native).toContain("node scripts/provider-object-disposition/browser-boundary/hosted-controls.mjs");
  expect(native).toContain("name: Remove owned provider browser boundary\n        if: always()");
  expect(native).toContain("name: Require full source checks\n        if: always()");
  expect(native).toContain("SOURCE_RESULT: ${{ needs.static-source.result }}");
  expect(native).toContain('run: test "$SOURCE_RESULT" = success');
  expect(workflow).toContain('require_job "Static Checks" "${{ needs.static.result }}"');
});

it("missing-key survival binds its own pre-stimulus snapshot, not the preceding browser case", () => {
  const controls = read("hosted-controls.mjs");
  const missing = controls.slice(
    controls.indexOf("async function missingOwnerKey("),
    controls.indexOf("async function setupNamesAbsent("),
  );
  expect(missing).toContain("missingOwnerKey(contexts, mode)");
  const baseline = 'const owned = await launchIdentities("baseline", contexts.length);';
  expect(missing).toContain(baseline);
  expect(missing.indexOf(baseline)).toBeLessThan(missing.indexOf('await mutate("apply")'));
  expect(missing).toContain('await ownerRefusal(contexts, owned, mode, "remove-ownership-census", "13d")');
  const refusal = controls.slice(
    controls.indexOf("async function ownerRefusal("),
    controls.indexOf("async function missingOwnerKey("),
  );
  expect(refusal).toContain('const survivalRecords = () => launchIdentities("survival", owned);');
  expect(refusal).toContain("assertIdentitySurvival(owned, beforeRemoval);");
  expect(refusal).toContain("assertIdentitySurvival(owned, after);");
  expect(refusal.indexOf("assertIdentitySurvival(owned, beforeRemoval);")).toBeLessThan(
    refusal.indexOf('await execute("/bin/bash"'),
  );
  expect(refusal.indexOf("assertIdentitySurvival(owned, after);")).toBeGreaterThan(
    refusal.indexOf('await execute("/bin/bash"'),
  );
});
