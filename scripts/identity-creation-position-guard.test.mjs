import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { executeIdentityCreationPositionGuard, identityCommandAnchors } from "./identity-creation-position-guard.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const registryPath = "scripts/identity-creation-positions.json";
const schemaPath = "scripts/identity-creation-positions.schema.json";
const testPath = "scripts/identity-creation-position-guard.test.mjs";
const guardPath = "scripts/identity-creation-position-guard.mjs";
const commands = identityCommandAnchors.map(({ command }) => command);
const fixtureOnlyPaths = [
  "bounded-contexts/auth/support/api-support/guest-checkout-routes.ts",
  "bounded-contexts/auth/support/api-support/register-routes.ts",
  "deployables/platform-api/src/bootstrap.ts",
];
let fixtureRoot;
let fixtureBase;

function commandPosition(command, terminator = "") {
  return ["type", `: "${command}"`, terminator].join("");
}

async function createFixture() {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "identity-position-guard-"));
  await git(["init", "--quiet"], fixtureRoot);
  await git(["config", "user.email", "identity-position-guard@example.test"], fixtureRoot);
  await git(["config", "user.name", "Identity Position Guard"], fixtureRoot);

  const discovered = new Set();
  for (const command of commands) {
    const result = await git(["grep", "-l", "-F", commandPosition(command), "--", "."], repositoryRoot, {
      allowFailure: true,
    });
    for (const value of result.stdout.split(/\r?\n/).filter(Boolean)) discovered.add(value);
  }

  for (const relativePath of [...discovered, ...fixtureOnlyPaths, registryPath, schemaPath, guardPath, testPath]) {
    await copyRepositoryFile(relativePath);
  }
  await writeFixture(".gitignore", "generated-output/\n");
  await git(["add", "."], fixtureRoot);
  await git(["commit", "--quiet", "-m", "identity position guard fixture"], fixtureRoot);
  fixtureBase = (await git(["rev-parse", "HEAD"], fixtureRoot)).stdout.trim();
}

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

await createFixture();

beforeEach(async () => {
  await git(["reset", "--hard", fixtureBase], fixtureRoot);
  await git(["clean", "-fdx"], fixtureRoot);
});

describe("identity creation position guard real discovery", () => {
  it("every command token cites a domain declaration anchor", async () => {
    const result = await runGuard();

    expect(result.exitCode).toBe(0);
    expect(result.report.violations).toEqual([]);
    expect(result.report.derivation).toEqual(
      identityCommandAnchors.map(({ id, path: anchorPath, command }) => ({
        anchorId: id,
        path: anchorPath,
        command,
        declaration: `  ${commandPosition(command, ";")}`,
      })),
    );
    expect(result.report.sweptFiles).toBe(result.report.trackedFiles);
    expect(result.report).not.toHaveProperty("excluded");
    expect(result.report.tokens).toEqual([
      { command: "CreateAccount", anchorId: "C1", hitCount: 21, registeredCount: 21, violationCount: 0 },
      { command: "CreateUser", anchorId: "C2", hitCount: 15, registeredCount: 15, violationCount: 0 },
      {
        command: "GrantMembership",
        anchorId: "C3",
        hitCount: 21,
        registeredCount: 21,
        violationCount: 0,
      },
    ]);
  });

  it.each(
    identityCommandAnchors.flatMap((anchor) => [
      { anchor, mode: "missing" },
      { anchor, mode: "diverged" },
    ]),
  )("$anchor.id fails closed when its authority is $mode", async ({ anchor, mode }) => {
    const absolute = fixturePath(anchor.path);
    if (mode === "missing") {
      await rm(absolute);
    } else {
      const source = (await readFile(absolute, "utf8")).replaceAll("\r\n", "\n");
      const current = `  ${commandPosition(anchor.command, ";")}`;
      const replacement =
        anchor.id === "C1"
          ? `  ${commandPosition(`${anchor.command}Renamed`, ";")}`
          : anchor.id === "C2"
            ? ` ${commandPosition(anchor.command, ";")}`
            : `${source.includes("  membershipId: MembershipId;") ? "  membershipId: MembershipId;\n" : ""}${current}`;
      const next =
        anchor.id === "C3"
          ? source.replace(`${current}\n  membershipId: MembershipId;`, replacement)
          : source.replace(current, replacement);
      await writeFile(absolute, next, "utf8");
    }

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain(
      mode === "missing" ? "identity-command-authority-unreadable" : "identity-command-authority-diverged",
    );
    expect(result.report.violations).toContainEqual(
      expect.objectContaining({ anchorId: anchor.id, path: anchor.path }),
    );
  });

  it("rejects an unknown key nested inside a registry position", async () => {
    const registry = await readRegistry();
    registry.positions[0].surprise = true;
    await writeRegistry(registry);

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("identity-creation-registry-schema-invalid");
    expect(result.report.violations).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('unknown member "surprise"'),
      }),
    );
  });

  it("rejects a schema whose nested position object is not closed", async () => {
    const schema = JSON.parse(await readFile(fixturePath(schemaPath), "utf8"));
    delete schema.properties.positions.items.additionalProperties;
    await writeJson(schemaPath, schema);

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("identity-creation-registry-schema-invalid");
    expect(result.stdout).toContain("#/properties/positions/items");
  });

  it.each([
    {
      label: "missing registry",
      code: "identity-creation-registry-missing",
      mutate: async () => rm(fixturePath(registryPath)),
    },
    {
      label: "unparseable registry",
      code: "identity-creation-registry-unparseable",
      mutate: async () => writeFixture(registryPath, "{"),
    },
    {
      label: "temporary position without an owner",
      code: "identity-creation-registry-owner-missing",
      mutate: async () => {
        const registry = await readRegistry();
        const position = registry.positions.find((entry) => entry.disposition === "exempt-temporary");
        delete position.ownerIssue;
        await writeRegistry(registry);
      },
    },
    {
      label: "blank reason",
      code: "identity-creation-registry-schema-invalid",
      mutate: async () => {
        const registry = await readRegistry();
        registry.positions[0].reason = " ";
        await writeRegistry(registry);
      },
    },
    {
      label: "generic test-support reason",
      code: "identity-creation-registry-reason-generic",
      mutate: async () => {
        const registry = await readRegistry();
        registry.positions[0].reason = "test support";
        await writeRegistry(registry);
      },
    },
  ])("fails closed for $label", async ({ code, mutate }) => {
    await mutate();

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain(code);
  });

  it.each([
    { delta: -1, label: "fewer" },
    { delta: 1, label: "more" },
  ])("rejects a registry count that pins $label occurrences", async ({ delta }) => {
    const registry = await readRegistry();
    const position = registry.positions.find(
      (entry) =>
        entry.path === "bounded-contexts/identity/features/accounts/domain/domain.test.ts" &&
        entry.command === "CreateAccount",
    );
    position.occurrences += delta;
    await writeRegistry(registry);

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("identity-creation-registry-stale");
  });

  it("rejects a registered path that no longer exists", async () => {
    const target = "bounded-contexts/identity/tests/internal-auth-routes.test.ts";
    await rm(fixturePath(target));

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toEqual(
      expect.arrayContaining(["identity-creation-corpus-unreadable", "identity-creation-registry-stale"]),
    );
    expect(result.report.violations).toContainEqual(
      expect.objectContaining({
        code: "identity-creation-registry-stale",
        path: target,
        command: "CreateAccount",
        observed: 0,
        registered: 1,
      }),
    );
  });

  it("rejects a registered command that no longer occurs in its path", async () => {
    const target = "bounded-contexts/identity/tests/internal-auth-routes.test.ts";
    const source = await readFile(fixturePath(target), "utf8");
    await writeFile(
      fixturePath(target),
      source.replace(commandPosition("CreateAccount"), 'kind: "AccountCreated"'),
      "utf8",
    );

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(result.report.violations).toContainEqual(
      expect.objectContaining({
        code: "identity-creation-registry-stale",
        path: target,
        command: "CreateAccount",
        observed: 0,
        registered: 1,
      }),
    );
  });

  it("rejects an extra occurrence inside an already registered file", async () => {
    const target = "bounded-contexts/identity/support/runtime-support/production-bootstrap.ts";
    await appendFile(fixturePath(target), `\nconst extra = { ${commandPosition("CreateAccount")} };\n`, "utf8");

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(result.report.violations).toContainEqual(
      expect.objectContaining({
        code: "identity-creation-registry-stale",
        path: target,
        command: "CreateAccount",
        observed: 2,
        registered: 1,
      }),
    );
  });

  it.each([
    "bounded-contexts/identity/support/runtime-support/production-bootstrap.ts",
    "bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts",
    "bounded-contexts/identity/support/runtime-support/seed.ts",
  ])("flags the historically omitted real root when its registry entries are deleted: %s", async (target) => {
    const registry = await readRegistry();
    registry.positions = registry.positions.filter((position) => position.path !== target);
    await writeRegistry(registry);

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(result.report.violations).toContainEqual(
      expect.objectContaining({
        code: "identity-creation-position-unclassified",
        path: target,
      }),
    );
  });

  it.each([
    {
      label: "sign-in-only route",
      path: "unfamiliar/auth/sign-in-only.ts",
      source: 'await signInWithPassword({ email: "allowed@example.test" });',
    },
    {
      label: "empty pre-activation resolution",
      path: "unfamiliar/auth/empty-preactivation.json",
      source: JSON.stringify({ bundleKey: "registration", requirements: [], affirmed: false }),
    },
    {
      label: "canonical identity client",
      path: "unfamiliar/auth/canonical-client.ts",
      source: "await identityMutations.createPersonalIdentity(params);",
    },
  ])("allows ordinary code that creates no direct command position: $label", async ({ path: target, source }) => {
    await writeTracked(target, `${source}\n`);

    const result = await runGuard();

    expect(result.exitCode).toBe(0);
    expect(result.report.violations).toEqual([]);
  });

  it("allows the real deployable bootstrap because it is canonical wiring, not a command construction position", async () => {
    const source = await readFile(fixturePath("deployables/platform-api/src/bootstrap.ts"), "utf8");
    for (const command of commands) expect(source).not.toContain(commandPosition(command));

    const result = await runGuard();

    expect(result.exitCode).toBe(0);
    expect(result.report.violations).toEqual([]);
  });

  it.each([
    { label: "arbitrary TypeScript path", path: "asteroid-field/unknown/new-position.ts" },
    { label: "non-TypeScript path", path: "asteroid-field/unknown/new-position.notes" },
  ])("flags an unregistered position at an $label", async ({ path: target }) => {
    await writeTracked(target, `const command = { ${commandPosition("CreateAccount")} };\n`);

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(result.report.violations).toContainEqual(
      expect.objectContaining({
        code: "identity-creation-position-unclassified",
        path: target,
        command: "CreateAccount",
      }),
    );
  });

  it("flags a seventh-path composition planted at an arbitrary route", async () => {
    const target = "unfamiliar-routes/guest-owned-identity.ts";
    await writeTracked(
      target,
      [
        `await createGuestAccount({ ${commandPosition("CreateAccount")} });`,
        `await createUser({ ${commandPosition("CreateUser")} });`,
        `await claimGuestAccount({ ${commandPosition("GrantMembership")} });`,
        "",
      ].join("\n"),
    );

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(result.report.violations.filter(({ path: value }) => value === target)).toEqual([
      expect.objectContaining({ code: "identity-creation-position-unclassified", command: "CreateAccount" }),
      expect.objectContaining({ code: "identity-creation-position-unclassified", command: "CreateUser" }),
      expect.objectContaining({ code: "identity-creation-position-unclassified", command: "GrantMembership" }),
    ]);
  });

  it("pins the existing guest-checkout composition and rejects a fourth command member", async () => {
    const registry = await readRegistry();
    const members = registry.positions.filter(({ composition }) => composition === "guest-checkout-account-claim");
    expect(members.map(({ command }) => command).sort()).toEqual(
      ["CreateAccount", "CreateUser", "GrantMembership"].sort(),
    );
    expect(members.every(({ ownerIssue }) => ownerIssue === 5684)).toBe(true);

    await appendFile(
      fixturePath("bounded-contexts/identity/api.ts"),
      `\nconst fourthGuestMember = { ${commandPosition("GrantMembership")} };\n`,
      "utf8",
    );
    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(result.report.violations).toContainEqual(
      expect.objectContaining({
        code: "identity-creation-registry-stale",
        path: "bounded-contexts/identity/api.ts",
        command: "GrantMembership",
        observed: 4,
        registered: 3,
      }),
    );
  });

  it.each([
    {
      label: "destructured registration client",
      path: "ordinary-evasions/destructured.ts",
      prefix: "const { register } = client;",
    },
    {
      label: "split-string URL",
      path: "ordinary-evasions/split-url.ts",
      prefix: 'const route = ["/api/auth", "register"].join("/");',
    },
    {
      label: "aliased contract",
      path: "ordinary-evasions/aliased-contract.ts",
      prefix: "const registration = contract as RegistrationAlias;",
    },
    {
      label: "same-named impostor binder",
      path: "ordinary-evasions/impostor.ts",
      prefix: "const createPersonalIdentity = localImpostor;",
    },
  ])(
    "flags direct command construction despite the old caller-classifier evasion: $label",
    async ({ path: target, prefix }) => {
      await writeTracked(target, `${prefix}\nconst command = { ${commandPosition("CreateUser")} };\n`);

      const result = await runGuard();

      expect(result.exitCode).toBe(1);
      expect(result.report.violations).toContainEqual(
        expect.objectContaining({
          code: "identity-creation-position-unclassified",
          path: target,
          command: "CreateUser",
        }),
      );
    },
  );

  it.each([
    { label: "invitation bite", path: "historical-bites/invitation-first-use.ts" },
    { label: "magic-link bite", path: "historical-bites/magic-link-first-use.ts" },
  ])(
    "flags the historical omitted first-use shape when it constructs identity commands: $label",
    async ({ path: target }) => {
      await writeTracked(
        target,
        [
          `const account = { ${commandPosition("CreateAccount")} };`,
          `const user = { ${commandPosition("CreateUser")} };`,
          `const membership = { ${commandPosition("GrantMembership")} };`,
          "",
        ].join("\n"),
      );

      const result = await runGuard();

      expect(result.exitCode).toBe(1);
      expect(result.report.violations.filter(({ path: value }) => value === target)).toHaveLength(3);
    },
  );

  it("enumerates the corpus from git ls-files, not a filesystem walk", async () => {
    const clean = await runGuard();
    await writeFixture(
      "generated-output/.react-router/types/untracked.ts",
      `const ignored = { ${commandPosition("CreateAccount")} };\n`,
    );
    const builtLike = await runGuard();

    expect(builtLike.exitCode).toBe(0);
    expect(builtLike.stdout).toBe(clean.stdout);

    await git(["add", "--force", "generated-output/.react-router/types/untracked.ts"], fixtureRoot);
    const tracked = await runGuard();
    expect(tracked.exitCode).toBe(1);
    expect(codes(tracked.report)).toContain("identity-creation-position-unclassified");
  });

  it("fails closed when a tracked corpus file is unreadable", async () => {
    const target = "unreadable/tracked-position.ts";
    await writeTracked(target, `const command = { ${commandPosition("CreateAccount")} };\n`);
    await rm(fixturePath(target));

    const result = await runGuard();

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("identity-creation-corpus-unreadable");
    expect(result.report.sweptFiles).toBe(result.report.trackedFiles - 1);
  });

  it("fails closed when git discovery runs outside a Git repository", async () => {
    const gitDirectory = fixturePath(".git");
    const disabled = fixturePath(".git-disabled");
    await rename(gitDirectory, disabled);
    try {
      const result = await runGuard();
      expect(result.exitCode).toBe(1);
      expect(codes(result.report)).toContain("identity-creation-corpus-discovery-failed");
    } finally {
      await rename(disabled, gitDirectory);
    }
  });

  it("fails closed when git reports zero tracked files", async () => {
    const emptyRoot = await mkdtemp(path.join(tmpdir(), "identity-position-empty-"));
    try {
      await git(["init", "--quiet"], emptyRoot);
      for (const relativePath of [
        ...identityCommandAnchors.map(({ path: anchorPath }) => anchorPath),
        registryPath,
        schemaPath,
      ]) {
        await copyRepositoryFile(relativePath, emptyRoot);
      }

      const result = await runGuard(emptyRoot);

      expect(result.exitCode).toBe(1);
      expect(codes(result.report)).toContain("identity-creation-corpus-empty");
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

async function runGuard(root = fixtureRoot) {
  return executeIdentityCreationPositionGuard({ repositoryRoot: root, json: true });
}

async function git(args, cwd, options = {}) {
  try {
    return await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (options.allowFailure) {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: error.code };
    }
    throw error;
  }
}

function codes(report) {
  return report.violations.map(({ code }) => code);
}

function fixturePath(relativePath, root = fixtureRoot) {
  return path.join(root, ...relativePath.split("/"));
}

async function copyRepositoryFile(relativePath, root = fixtureRoot) {
  const destination = fixturePath(relativePath, root);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(repositoryRoot, ...relativePath.split("/")), destination);
}

async function writeFixture(relativePath, contents, root = fixtureRoot) {
  const destination = fixturePath(relativePath, root);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents, "utf8");
}

async function writeTracked(relativePath, contents) {
  await writeFixture(relativePath, contents);
  await git(["add", "--", relativePath], fixtureRoot);
}

async function readRegistry() {
  return JSON.parse(await readFile(fixturePath(registryPath), "utf8"));
}

async function writeRegistry(value) {
  await writeJson(registryPath, value);
}

async function writeJson(relativePath, value) {
  await writeFixture(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}
