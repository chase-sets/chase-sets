import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const sandbox = {
    composeProjectName: "chase-sets-fixture",
    envFilePath: ".env.sandbox.fixture",
  };
  const sandboxEnv = {
    CHASE_SETS_SANDBOX_ID: "fixture",
    COMPOSE_PROJECT_NAME: sandbox.composeProjectName,
  };

  return {
    sandbox,
    sandboxEnv,
    normalizeSandboxWorktreeIdentity: vi.fn(),
    spawnSync: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  spawnSync: fixture.spawnSync,
}));

vi.mock("./lib/sandbox.mjs", () => ({
  applySandboxEnv: vi.fn(),
  buildDockerComposeArgs: (sandbox, subcommand = []) => [
    "compose",
    "--env-file",
    sandbox.envFilePath,
    "-f",
    "docker-compose.dev.yml",
    "-p",
    sandbox.composeProjectName,
    ...subcommand,
  ],
  buildSandboxEnv: vi.fn(() => fixture.sandboxEnv),
  ensureWorktreeSandboxEnvironment: vi.fn(() => ({
    sandbox: fixture.sandbox,
    env: fixture.sandboxEnv,
  })),
  normalizeSandboxWorktreeIdentity: fixture.normalizeSandboxWorktreeIdentity,
}));

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

async function runSandboxCommand(command) {
  process.argv = [process.execPath, "scripts/sandbox.mjs", command];
  vi.resetModules();
  await import("./sandbox.mjs");
}

function dockerCalls() {
  return fixture.spawnSync.mock.calls.map(([command, args, options]) => ({ command, args, options }));
}

beforeEach(() => {
  fixture.normalizeSandboxWorktreeIdentity.mockReset();
  fixture.normalizeSandboxWorktreeIdentity.mockImplementation((value) =>
    String(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(),
  );
  fixture.spawnSync.mockReset();
  fixture.spawnSync.mockReturnValue({
    error: undefined,
    status: 0,
    stdout: "",
  });
  process.exitCode = originalExitCode;
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("sandbox Compose teardown commands", () => {
  it("orders CHECKPOINT before the retained-volume sandbox down", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSandboxCommand("down");

    const calls = dockerCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: "docker",
      args: [
        "compose",
        "--env-file",
        fixture.sandbox.envFilePath,
        "-f",
        "docker-compose.dev.yml",
        "-p",
        fixture.sandbox.composeProjectName,
        "exec",
        "-T",
        "postgres",
        "sh",
        "-ceu",
        'exec psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command CHECKPOINT',
      ],
    });
    expect(calls[1]).toMatchObject({
      command: "docker",
      args: [
        "compose",
        "--env-file",
        fixture.sandbox.envFilePath,
        "-f",
        "docker-compose.dev.yml",
        "-p",
        fixture.sandbox.composeProjectName,
        "down",
      ],
    });
    expect(calls.every(({ args }) => args[0] === "compose")).toBe(true);
    expect(calls.every(({ options }) => options.env.CHASE_SETS_SANDBOX_ID === "fixture")).toBe(true);
    expect(calls.every(({ options }) => options.timeout === undefined && options.timeoutMs === undefined)).toBe(true);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "Flushing the sandbox PostgreSQL shutdown checkpoint...",
      "Sandbox PostgreSQL shutdown checkpoint completed.",
    ]);
  });

  it("keeps sandbox clean as one destructive down -v without a checkpoint", async () => {
    await runSandboxCommand("clean");

    expect(dockerCalls()).toEqual([
      expect.objectContaining({
        command: "docker",
        args: [
          "compose",
          "--env-file",
          fixture.sandbox.envFilePath,
          "-f",
          "docker-compose.dev.yml",
          "-p",
          fixture.sandbox.composeProjectName,
          "down",
          "-v",
        ],
      }),
    ]);
    expect(dockerCalls()[0].args.some((argument) => argument.includes("CHECKPOINT"))).toBe(false);
  });

  it("degrades a failed checkpoint to down without adding a timeout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    fixture.spawnSync.mockImplementation((_command, args) => ({
      error: undefined,
      status: args.some((argument) => argument.includes("CHECKPOINT")) ? 1 : 0,
      stdout: "",
    }));

    await runSandboxCommand("down");

    const calls = dockerCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].args.some((argument) => argument.includes("CHECKPOINT"))).toBe(true);
    expect(calls[1].args.at(-1)).toBe("down");
    expect(calls.every(({ options }) => options.timeout === undefined && options.timeoutMs === undefined)).toBe(true);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "Flushing the sandbox PostgreSQL shutdown checkpoint...",
      expect.stringContaining(
        "Sandbox PostgreSQL was unavailable for a shutdown checkpoint; continuing with Compose teardown:",
      ),
    ]);
    expect(process.exitCode).toBe(originalExitCode);
  });
});

const ownerLabel = "com.chase-sets.sandbox.owner";
const sandboxIdLabel = "com.chase-sets.sandbox.id";
const worktreeLabel = "com.chase-sets.sandbox.worktree";
const projectLabel = "com.docker.compose.project";
const volumeKindLabel = "com.docker.compose.volume";
const networkKindLabel = "com.docker.compose.network";
const hexId = (character) => character.repeat(64);

function gitWorktrees(...records) {
  return `${records
    .map(
      ({ path, detached = false }, index) =>
        `worktree ${path}\nHEAD ${String(index + 1).repeat(40)}\n${
          detached ? "detached" : `branch refs/heads/feature-${index + 1}`
        }`,
    )
    .join("\n\n")}\n`;
}

function ownedLabels(projectName, worktree, extra = {}) {
  return {
    [projectLabel]: projectName,
    [ownerLabel]: "local-worktree-v1",
    [sandboxIdLabel]: projectName.slice("chase-sets-".length),
    [worktreeLabel]: worktree.toLowerCase(),
    ...extra,
  };
}

function containerRecord({ id, projectName, worktree, status = "exited", running = status !== "exited", labels }) {
  const canonicalWorktree = worktree.toLowerCase();
  return {
    Id: id,
    Config: {
      Labels:
        labels ??
        ownedLabels(projectName, canonicalWorktree, {
          "com.docker.compose.service": "postgres",
          "com.docker.compose.project.working_dir": canonicalWorktree,
          "com.docker.compose.project.config_files": `${canonicalWorktree}/docker-compose.dev.yml`,
        }),
    },
    State: { Running: running, Status: status },
  };
}

function resourceRecord({ type, projectName, worktree, kind, name, id, labels }) {
  const resolvedName = name ?? `${projectName}_${kind}`;
  return {
    name: resolvedName,
    id: type === "network" ? (id ?? hexId("b")) : resolvedName,
    inspectSequence: [
      {
        Name: resolvedName,
        ...(type === "network" ? { Id: id ?? hexId("b") } : {}),
        Labels:
          labels ??
          ownedLabels(projectName, worktree, {
            [type === "network" ? networkKindLabel : volumeKindLabel]: kind,
          }),
      },
    ],
  };
}

function successful(stdout = "") {
  return { error: undefined, status: 0, stdout };
}

function installSandboxHarness({
  gitResult = successful(gitWorktrees({ path: "C:\\repos\\registered" })),
  projects = [],
  volumes = [],
  networks = [],
  volumeListOutput,
  networkListOutput,
} = {}) {
  const projectListCounts = new Map();
  const activeProjectSnapshots = new Map();
  const resourceInspectCounts = new Map();

  fixture.spawnSync.mockImplementation((command, args) => {
    if (command === "git") {
      if (args.join("\0") !== ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"].join("\0")) {
        throw new Error(`Unexpected Git command: git ${args.join(" ")}`);
      }
      return gitResult;
    }
    if (command !== "docker") {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }
    if (args[0] === "compose" && args[1] === "ls") {
      return successful(
        JSON.stringify(
          projects.map(({ name, status }) => ({
            Name: name,
            Status: status,
          })),
        ),
      );
    }
    if (args[0] === "container" && args[1] === "ls") {
      const filter = args.find((argument) => argument.startsWith(`label=${projectLabel}=`));
      const projectName = filter?.slice(`label=${projectLabel}=`.length);
      const project = projects.find(({ name }) => name === projectName);
      const count = projectListCounts.get(projectName) ?? 0;
      const snapshots = project?.snapshots ?? [project?.containers ?? []];
      const snapshot = snapshots[Math.min(count, snapshots.length - 1)] ?? [];
      projectListCounts.set(projectName, count + 1);
      activeProjectSnapshots.set(projectName, snapshot);
      return successful(snapshot.map(({ Id }) => Id).join("\n"));
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const ids = args.slice(2);
      const records = [...activeProjectSnapshots.values()].flat().filter(({ Id }) => ids.includes(Id));
      return successful(JSON.stringify(records));
    }
    if (args[0] === "volume" && args[1] === "ls") {
      return successful(volumeListOutput ?? volumes.map(({ name }) => name).join("\n"));
    }
    if (args[0] === "network" && args[1] === "ls") {
      return successful(networkListOutput ?? networks.map(({ id, name }) => `${id}\t${name}`).join("\n"));
    }
    if (["volume", "network"].includes(args[0]) && args[1] === "inspect") {
      const resources = args[0] === "volume" ? volumes : networks;
      const resource = resources.find(({ id, name }) => [id, name].includes(args[2]));
      if (!resource) {
        return successful("[]");
      }
      const key = `${args[0]}:${resource.id}`;
      const count = resourceInspectCounts.get(key) ?? 0;
      const record = resource.inspectSequence[Math.min(count, resource.inspectSequence.length - 1)];
      resourceInspectCounts.set(key, count + 1);
      return successful(JSON.stringify([record]));
    }
    if (
      (args[0] === "compose" && args.includes("down")) ||
      (["volume", "network"].includes(args[0]) && args[1] === "rm")
    ) {
      return successful();
    }
    throw new Error(`Unexpected Docker command: docker ${args.join(" ")}`);
  });
}

function destructiveCalls() {
  return dockerCalls().filter(
    ({ command, args }) =>
      command === "docker" && (args.includes("down") || (["volume", "network"].includes(args[0]) && args[1] === "rm")),
  );
}

describe("sandbox garbage collection", () => {
  it.each([
    ["Git process error", { error: new Error("git failed"), status: null, stdout: "" }],
    ["nonzero Git exit", { error: undefined, status: 1, stdout: "" }],
    ["empty Git output", successful("")],
    ["malformed Git output", successful("worktree C:\\repos\\registered\nHEAD not-a-commit\nbranch refs/heads/main\n")],
  ])("fails closed on %s", async (_name, gitResult) => {
    installSandboxHarness({ gitResult });

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(1);
    expect(destructiveCalls()).toEqual([]);
  });

  it("fails closed when a worktree identity resolver errors", async () => {
    fixture.normalizeSandboxWorktreeIdentity.mockImplementation(() => {
      throw new Error("cannot canonicalize");
    });
    installSandboxHarness();

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(1);
    expect(destructiveCalls()).toEqual([]);
  });

  it("fails closed on case-insensitive duplicate worktree identities", async () => {
    installSandboxHarness({
      gitResult: successful(
        gitWorktrees({ path: "C:\\Repos\\Feature", detached: true }, { path: "c:\\repos\\feature" }),
      ),
    });

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(1);
    expect(destructiveCalls()).toEqual([]);
  });

  it("protects explicit IDs for detached and no-upstream worktrees with path case, spaces, and Unicode", async () => {
    const spacedPath = "c:/repos/feature space";
    const unicodePath = "c:/repos/カード";
    const registeredVolume = resourceRecord({
      type: "volume",
      projectName: "chase-sets-explicit-id",
      worktree: spacedPath,
      kind: "chase-sets-postgres-dev-data",
    });
    installSandboxHarness({
      gitResult: successful(
        gitWorktrees({ path: "C:\\Repos\\Feature Space", detached: true }, { path: "C:\\Repos\\カード" }),
      ),
      projects: [
        {
          name: "chase-sets-explicit-id",
          status: "exited(1)",
          containers: [
            containerRecord({
              id: hexId("1"),
              projectName: "chase-sets-explicit-id",
              worktree: spacedPath,
            }),
          ],
        },
        {
          name: "chase-sets-unicode-id",
          status: "exited(1)",
          containers: [
            containerRecord({
              id: hexId("2"),
              projectName: "chase-sets-unicode-id",
              worktree: unicodePath,
            }),
          ],
        },
      ],
      volumes: [registeredVolume],
    });

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(originalExitCode);
    expect(destructiveCalls()).toEqual([]);
  });

  it("removes only a stopped owned orphan from a mixed running/stopped set", async () => {
    installSandboxHarness({
      projects: [
        {
          name: "chase-sets-running",
          status: "running(1)",
          containers: [
            containerRecord({
              id: hexId("3"),
              projectName: "chase-sets-running",
              worktree: "c:/repos/deleted-running",
              status: "running",
            }),
          ],
        },
        {
          name: "chase-sets-stopped",
          status: "exited(1)",
          containers: [
            containerRecord({
              id: hexId("4"),
              projectName: "chase-sets-stopped",
              worktree: "c:/repos/deleted-stopped",
            }),
          ],
        },
      ],
    });

    await runSandboxCommand("gc");

    const downProjects = destructiveCalls()
      .filter(({ args }) => args.includes("down"))
      .map(({ args }) => args[args.indexOf("-p") + 1]);
    expect(downProjects).toEqual(["chase-sets-stopped"]);
  });

  it("skips a stopped candidate that becomes active during immediate reinspection", async () => {
    const stopped = containerRecord({
      id: hexId("5"),
      projectName: "chase-sets-racing",
      worktree: "c:/repos/deleted-racing",
    });
    const running = { ...stopped, State: { Running: true, Status: "running" } };
    installSandboxHarness({
      projects: [
        {
          name: "chase-sets-racing",
          status: "exited(1)",
          snapshots: [[stopped], [running]],
        },
      ],
    });

    await runSandboxCommand("gc");

    expect(destructiveCalls()).toEqual([]);
  });

  it("removes fully owned detached resources by canonical volume name and exact network ID", async () => {
    const volume = resourceRecord({
      type: "volume",
      projectName: "chase-sets-orphan",
      worktree: "c:/repos/deleted",
      kind: "chase-sets-postgres-dev-data",
    });
    const network = resourceRecord({
      type: "network",
      projectName: "chase-sets-orphan",
      worktree: "c:/repos/deleted",
      kind: "default",
      id: hexId("6"),
    });
    installSandboxHarness({ volumes: [volume], networks: [network] });

    await runSandboxCommand("gc");

    expect(destructiveCalls().map(({ args }) => args)).toEqual([
      ["volume", "rm", volume.name],
      ["network", "rm", network.id],
    ]);
  });

  it("does not authorize project-label-only resources", async () => {
    const volume = resourceRecord({
      type: "volume",
      projectName: "chase-sets-orphan",
      worktree: "c:/repos/deleted",
      kind: "chase-sets-postgres-dev-data",
      name: "personal-volume",
      labels: { [projectLabel]: "chase-sets-orphan" },
    });
    const network = resourceRecord({
      type: "network",
      projectName: "chase-sets-orphan",
      worktree: "c:/repos/deleted",
      kind: "default",
      name: "personal-network",
      id: hexId("7"),
      labels: { [projectLabel]: "chase-sets-orphan" },
    });
    installSandboxHarness({ volumes: [volume], networks: [network] });

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(originalExitCode);
    expect(destructiveCalls()).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["mismatched", "unexpected-volume"],
  ])("fails closed on %s resource-kind ownership", async (_name, kindLabel) => {
    const projectName = "chase-sets-orphan";
    const worktree = "c:/repos/deleted";
    const labels = ownedLabels(projectName, worktree);
    if (kindLabel !== undefined) {
      labels[volumeKindLabel] = kindLabel;
    }
    const volume = resourceRecord({
      type: "volume",
      projectName,
      worktree,
      kind: "chase-sets-postgres-dev-data",
      labels,
    });
    installSandboxHarness({ volumes: [volume] });

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(1);
    expect(destructiveCalls()).toEqual([]);
  });

  it("fails closed on conflicting volume and network kind labels", async () => {
    const projectName = "chase-sets-orphan";
    const worktree = "c:/repos/deleted";
    const volume = resourceRecord({
      type: "volume",
      projectName,
      worktree,
      kind: "chase-sets-postgres-dev-data",
      labels: ownedLabels(projectName, worktree, {
        [volumeKindLabel]: "chase-sets-postgres-dev-data",
        [networkKindLabel]: "default",
      }),
    });
    installSandboxHarness({ volumes: [volume] });

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(1);
    expect(destructiveCalls()).toEqual([]);
  });

  it("fails closed on malformed inspect data", async () => {
    const volume = resourceRecord({
      type: "volume",
      projectName: "chase-sets-orphan",
      worktree: "c:/repos/deleted",
      kind: "chase-sets-postgres-dev-data",
    });
    volume.inspectSequence = [{ Name: volume.name, Labels: null }];
    installSandboxHarness({ volumes: [volume] });

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(1);
    expect(destructiveCalls()).toEqual([]);
  });

  it("skips an unrelated prefixed Compose project with no Chase Sets ownership", async () => {
    const projectName = "chase-sets-personal";
    installSandboxHarness({
      projects: [
        {
          name: projectName,
          status: "exited(1)",
          containers: [
            containerRecord({
              id: hexId("8"),
              projectName,
              worktree: "c:/repos/personal",
              labels: {
                [projectLabel]: projectName,
                "com.docker.compose.service": "personal",
              },
            }),
          ],
        },
      ],
    });

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(originalExitCode);
    expect(destructiveCalls()).toEqual([]);
  });

  it.each([
    ["malformed volume listing", { volumeListOutput: " bad-name" }],
    ["duplicate volume name", { volumeListOutput: "duplicate\nduplicate" }],
    [
      "duplicate network name",
      {
        networkListOutput: `${hexId("9")}\tduplicate-network\n${hexId("a")}\tduplicate-network`,
      },
    ],
    ["duplicate network ID", { networkListOutput: `${hexId("9")}\tleft\n${hexId("9")}\tright` }],
  ])("fails closed on %s", async (_name, listOverrides) => {
    installSandboxHarness(listOverrides);

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(1);
    expect(destructiveCalls()).toEqual([]);
  });

  it("fails closed when resource authority labels change during immediate reinspection", async () => {
    const volume = resourceRecord({
      type: "volume",
      projectName: "chase-sets-orphan",
      worktree: "c:/repos/deleted",
      kind: "chase-sets-postgres-dev-data",
    });
    volume.inspectSequence.push({
      ...volume.inspectSequence[0],
      Labels: ownedLabels("chase-sets-orphan", "c:/repos/changed", {
        [volumeKindLabel]: "chase-sets-postgres-dev-data",
      }),
    });
    installSandboxHarness({ volumes: [volume] });

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(1);
    expect(destructiveCalls()).toEqual([]);
  });

  it("fails closed when project authority labels change during immediate reinspection", async () => {
    const projectName = "chase-sets-changing";
    const initial = containerRecord({
      id: hexId("c"),
      projectName,
      worktree: "c:/repos/deleted",
    });
    const changed = containerRecord({
      id: hexId("c"),
      projectName,
      worktree: "c:/repos/changed",
    });
    installSandboxHarness({
      projects: [
        {
          name: projectName,
          status: "exited(1)",
          snapshots: [[initial], [changed]],
        },
      ],
    });

    await runSandboxCommand("gc");

    expect(process.exitCode).toBe(1);
    expect(destructiveCalls()).toEqual([]);
  });

  it.each([
    ["Windows-shaped", "C:\\Repos\\Registered", "c:/repos/registered"],
    ["POSIX-shaped", "/repos/registered", "/repos/registered"],
  ])(
    "keeps fully owned detached resources for a registered %s worktree on every host",
    async (_shape, registeredPath, worktree) => {
      const volume = resourceRecord({
        type: "volume",
        projectName: "chase-sets-explicit",
        worktree,
        kind: "chase-sets-postgres-dev-data",
      });
      installSandboxHarness({
        gitResult: successful(gitWorktrees({ path: registeredPath })),
        volumes: [volume],
      });

      await runSandboxCommand("gc");

      expect(destructiveCalls()).toEqual([]);
    },
  );

  it("keeps clean-all deliberately destructive while retaining exact ownership checks", async () => {
    const runningProject = "chase-sets-running";
    const network = resourceRecord({
      type: "network",
      projectName: "chase-sets-detached",
      worktree: "c:/repos/deleted",
      kind: "default",
      id: hexId("d"),
    });
    installSandboxHarness({
      projects: [
        {
          name: runningProject,
          status: "running(1)",
          containers: [
            containerRecord({
              id: hexId("e"),
              projectName: runningProject,
              worktree: "c:/repos/running",
              status: "running",
            }),
          ],
        },
      ],
      networks: [network],
    });

    await runSandboxCommand("clean-all");

    expect(destructiveCalls().map(({ args }) => args)).toEqual([
      [
        "compose",
        "--env-file",
        fixture.sandbox.envFilePath,
        "-f",
        "docker-compose.dev.yml",
        "-p",
        runningProject,
        "down",
        "-v",
      ],
      ["network", "rm", network.id],
    ]);
  });
});
