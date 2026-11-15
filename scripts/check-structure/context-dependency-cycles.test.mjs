import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findContextDependencyCycleViolations as check } from "./context-dependency-cycles.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const vertex = (packageName, allowedContextDependencies = []) => ({ packageName, allowedContextDependencies });
const manifests = () =>
  readdirSync(path.join(root, "bounded-contexts"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(path.join(root, "bounded-contexts", entry.name, "context.json"), "utf8")));

describe("context dependency graph", () => {
  it.each([
    [[vertex("b", ["a"]), vertex("a", ["b"])], "a -> b -> a"],
    [[vertex("c", ["a"]), vertex("a", ["b"]), vertex("b", ["c"])], "a -> b -> c -> a"],
    [[vertex("a", ["a"])], "a -> a"],
  ])("rejects cycles with deterministic package paths", (input, cycle) => {
    expect(check(input)).toEqual([`context-dependency-cycle: ${cycle}`]);
    expect(check([...input].reverse())).toEqual(check(input));
  });
  it("accepts disconnected DAGs and treats non-context packages as terminal", () => {
    expect(check([vertex("a", ["b", "contract"]), vertex("b"), vertex("c", ["d"]), vertex("d")])).toEqual([]);
  });
  it.each([null, {}, [null], [vertex("a", null)], [vertex("a", [1])], [vertex("")], [vertex("a"), vertex("a")]])(
    "fails closed on malformed input %j",
    (input) => expect(check(input)[0]).toMatch(/^context-dependency-graph:/),
  );
  it("accepts the real graph and rejects the restored Auth/Payments cycle in memory", () => {
    const real = manifests();
    expect(check(real)).toEqual([]);
    const restored = structuredClone(real);
    restored.find((entry) => entry.contextName === "auth").allowedContextDependencies.push("@chase-sets/payments");
    restored.find((entry) => entry.contextName === "payments").allowedContextDependencies.push("@chase-sets/auth");
    expect(check(restored)).toContain(
      "context-dependency-cycle: @chase-sets/auth -> @chase-sets/payments -> @chase-sets/auth",
    );
  });
  it("removes both production package edges but retains Auth's test-only dependency", () => {
    const pkg = (context) =>
      JSON.parse(readFileSync(path.join(root, "bounded-contexts", context, "package.json"), "utf8"));
    for (const group of ["dependencies", "optionalDependencies", "peerDependencies"])
      expect(pkg("auth")[group]?.["@chase-sets/payments"]).toBeUndefined();
    expect(pkg("auth").devDependencies["@chase-sets/payments"]).toBe("workspace:*");
    for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])
      expect(pkg("payments")[group]?.["@chase-sets/auth"]).toBeUndefined();
  });
  it("moves the claim-only keys and POST-form declarations to Auth while keeping Payments retry metadata", () => {
    const locale = (owner) => readFileSync(path.join(root, `contracts/localization/locales/en/${owner}.ts`), "utf8");
    for (const key of [
      "claim.token",
      "contact.name",
      "could.not.save.order",
      "email.me.a.claim.link",
      "save.with.passkey",
      "local.recovery.token.in.production",
    ]) {
      expect(locale("auth")).toContain(`"auth.routes.marketplace.guestPaymentClaim.${key}"`);
      expect(locale("payments")).not.toContain(`"payments.routes.marketplace.accountPayment.${key}"`);
    }
    const real = manifests();
    const auth = real.find((entry) => entry.contextName === "auth");
    const payments = real.find((entry) => entry.contextName === "payments");
    const claim = auth.mutationConsistencyInventory.find(
      (entry) => entry.id === "auth.guest-payment-claim-command-snapshots",
    );
    expect(claim.surfaces.filter((surface) => surface.startsWith("post-form:"))).toHaveLength(3);
    expect(claim.surfaces.every((surface) => !surface.includes("bounded-contexts/payments/"))).toBe(true);
    expect(
      payments.mutationConsistencyInventory.some((entry) => entry.id === "payments.guest-claim-command-snapshots"),
    ).toBe(false);
    expect(payments.mutationConsistencyInventory.some((entry) => entry.id === "payments.detail-retry-fresh-read")).toBe(
      true,
    );
  });
  it.each([
    ["auth", "payments"],
    ["payments", "auth"],
  ])("has no production import from %s to %s", (from, to) => {
    const files = execFileSync("git", ["ls-files", "--", `bounded-contexts/${from}`], { cwd: root, encoding: "utf8" })
      .trim()
      .split(/\r?\n/);
    const violations = files
      .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !/(?:^|\/)(?:tests|__tests__)\/|\.(?:test|spec)\./.test(file))
      .filter((file) => new RegExp(`@chase-sets/${to}["'/]`).test(readFileSync(path.join(root, file), "utf8")));
    expect(violations).toEqual([]);
  });
});
