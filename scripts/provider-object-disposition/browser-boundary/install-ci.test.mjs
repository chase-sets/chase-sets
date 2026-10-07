import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SOURCE_FILES } from "../test-window-browser.mjs";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const launcher = read("launcher.c");
const installer = read("install-ci.sh");

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
  for (const name of ["target-absent", "profile-absent", "input-absent", "profile-census", "profile-present"]) {
    expect(cleanup.indexOf(name)).toBeGreaterThan(cleanup.indexOf("mark verify-exact-names"));
    expect(cleanup.indexOf(name)).toBeLessThan(cleanup.indexOf("mark complete"));
  }
});
