import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every child_process API is replaced: `spawn` becomes a fake `gh` that
// records argv, options, environment and stdin; anything else is recorded as
// a forbidden spawn and throws.
const gh = vi.hoisted(() => ({ calls: [], forbidden: [], respond: () => ({}), actual: null }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { EventEmitter } = await import("node:events");
  const { PassThrough: Pipe, Writable } = await import("node:stream");
  gh.actual = actual;
  const forbidden = (name) => (command) => {
    gh.forbidden.push({ api: name, command });
    throw new Error(`forbidden ${name}`);
  };
  const spawn = (command, args = [], options = {}) => {
    const call = { command, args: [...args], options, stdin: null };
    gh.calls.push(call);
    if (command !== "gh") gh.forbidden.push({ api: "spawn", command });
    const child = new EventEmitter();
    const stdio = options.stdio ?? ["pipe", "pipe", "pipe"];
    child.stdout = stdio[1] === "pipe" ? new Pipe() : null;
    child.stderr = stdio[2] === "pipe" ? new Pipe() : null;
    const finish = () => {
      const response = gh.respond(call) ?? {};
      const ended = [child.stdout, child.stderr]
        .filter(Boolean)
        .map((stream) => new Promise((resolve) => stream.on("end", resolve)));
      child.stdout?.end(response.stdout ?? "");
      child.stderr?.end(response.stderr ?? "");
      void Promise.all(ended).then(() => child.emit("close", response.code ?? 0, null));
    };
    if (stdio[0] === "pipe") {
      call.stdin = "";
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          call.stdin += chunk.toString();
          callback();
        },
        final(callback) {
          callback();
          setImmediate(finish);
        },
      });
    } else {
      child.stdin = null;
      setImmediate(finish);
    }
    return child;
  };
  return {
    ...actual,
    spawn,
    exec: forbidden("exec"),
    execFile: forbidden("execFile"),
    execFileSync: forbidden("execFileSync"),
    execSync: forbidden("execSync"),
    fork: forbidden("fork"),
    spawnSync: forbidden("spawnSync"),
  };
});

import { validateCredentialInventory } from "./credential-inventory.mjs";
import { SUBCOMMANDS } from "./ops.mjs";
import { runCredentialRotate } from "./credential-rotate.mjs";

const SENTINEL = "SENTINEL_ROTATE_VALUE_9914";
const SENTINEL_PARTNER = "SENTINEL_ROTATE_PARTNER_9914";
const ENVIRONMENTS = ["merge-gate", "preview", "production", "staging"];
const RUN_URL = "https://github.com/chase-sets/chase-sets/actions/runs/";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function entry(name, overrides = {}) {
  return {
    name,
    scope: ["production", "staging"],
    kind: "credential",
    rotation: "assisted",
    providerExpiryDays: null,
    maxAgeDays: 365,
    liveness: null,
    pairedWith: [],
    proofWorkflows: [],
    ...overrides,
  };
}

function inventoryOf(secrets) {
  const { errors, inventory } = validateCredentialInventory({ schemaVersion: 1, environments: ENVIRONMENTS, secrets });
  expect(errors).toEqual([]);
  return inventory;
}

// Sorted by name, as the inventory validator requires.
const INVENTORY = inventoryOf([
  entry("AUTOMATIC_TOKEN", { rotation: "automatic", maxAgeDays: 90 }),
  entry("COOKIE", { scope: ["production"], rotation: "external-owner", owner: 8447 }),
  entry("DO_TOKEN", {
    scope: ["production"],
    providerExpiryDays: 90,
    liveness: { kind: "digitalocean-account" },
    proofWorkflows: ["platform-credential-health.yml", "platform-digitalocean-drift-digest.yml"],
  }),
  entry("FORMAT_TOKEN", { scope: ["staging"] }),
  entry("MIXED_PARTNER", { pairedWith: ["MIXED_PRIMARY"] }),
  entry("MIXED_PRIMARY", { pairedWith: ["MIXED_PARTNER"], valueGroups: [["production", "staging"]] }),
  entry("PAIR_ACCESS_ID", {
    scope: ENVIRONMENTS,
    valueGroups: [ENVIRONMENTS],
    liveness: { kind: "spaces-list-buckets" },
    pairedWith: ["PAIR_SECRET_KEY"],
    proofWorkflows: ["platform-credential-health.yml"],
  }),
  entry("PAIR_SECRET_KEY", {
    scope: ENVIRONMENTS,
    valueGroups: [ENVIRONMENTS],
    pairedWith: ["PAIR_ACCESS_ID"],
    proofWorkflows: ["platform-credential-health.yml", "representative-catalog-snapshot.yml"],
  }),
  entry("REPO_TOKEN", { scope: "repository", proofWorkflows: ["project-status-sync.yml"] }),
  entry("STRIPE_LIKE_PUBLISHABLE", { scope: ENVIRONMENTS, pairedWith: ["STRIPE_LIKE_SECRET"] }),
  entry("STRIPE_LIKE_SECRET", { scope: ENVIRONMENTS, pairedWith: ["STRIPE_LIKE_PUBLISHABLE"] }),
  entry("TIED_TO_AUTOMATIC", { scope: ["staging"], pairedWith: ["TIED_TO_AUTOMATIC_PARTNER"] }),
  entry("TIED_TO_AUTOMATIC_PARTNER", {
    scope: ["staging"],
    rotation: "automatic",
    maxAgeDays: 90,
    pairedWith: ["TIED_TO_AUTOMATIC"],
  }),
]);

function capture() {
  let text = "";
  const stream = new PassThrough();
  stream.on("data", (chunk) => {
    text += chunk.toString();
  });
  return { stream, read: () => text };
}

// Piped (non-TTY) stdin carrying one value per line.
function pipedStdin(lines) {
  const stdin = new PassThrough();
  stdin.isTTY = false;
  stdin.end(lines.map((line) => `${line}\n`).join(""));
  return stdin;
}

// A TTY stdin that records raw-mode changes and types `keys` once raw mode is on.
function ttyStdin(keys) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.rawModes = [];
  stdin.setRawMode = (mode) => {
    stdin.rawModes.push(mode);
    if (mode && !stdin.typed) {
      stdin.typed = true;
      setImmediate(() => stdin.write(keys));
    }
    return stdin;
  };
  return stdin;
}

function liveFetch() {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, authorization: init?.headers?.authorization ?? "" });
    return new Response("", { status: 200 });
  };
  return { fetch, requests };
}

async function rotate(argv, { stdin = pipedStdin([SENTINEL]), fetch = liveFetch().fetch, inventory = INVENTORY } = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await runCredentialRotate(argv, {
    inventory,
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    fetch,
  });
  return { code, stdout: stdout.read(), stderr: stderr.read(), output: stdout.read() + stderr.read() };
}

const secretSets = () => gh.calls.filter((call) => call.args[0] === "secret");
const workflowRuns = () => gh.calls.filter((call) => call.args[0] === "workflow");
const writeOrder = () =>
  secretSets().map((call) => `${call.args[2]}@${call.args.includes("--env") ? call.args.at(-1) : "repository"}`);

function respondWithRunUrls(overrides = () => undefined) {
  let run = 1000;
  gh.respond = (call) => {
    const override = overrides(call);
    if (override) return override;
    if (call.args[0] === "workflow") {
      run += 1;
      return { stdout: `${RUN_URL}${run}\n` };
    }
    return { stdout: `Set Actions secret ${call.args[2]}\n` };
  };
}

beforeEach(() => {
  gh.calls.length = 0;
  gh.forbidden.length = 0;
  respondWithRunUrls();
});

describe("credential:rotate registration", () => {
  it("is an ops subcommand backed by credential-rotate.mjs", () => {
    expect(SUBCOMMANDS["credential:rotate"].script).toBe("credential-rotate.mjs");
  });

  it("dry-runs DIGITALOCEAN_READONLY_TOKEN through the ops entry point against the checked-in inventory", () => {
    const result = gh.actual.spawnSync(
      process.execPath,
      ["scripts/ops.mjs", "credential:rotate", "--secret", "DIGITALOCEAN_READONLY_TOKEN", "--dry-run"],
      { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("gh secret set DIGITALOCEAN_READONLY_TOKEN --env production");
    expect(result.stdout).toContain("liveness digitalocean-account");
    expect(result.stdout).toContain("gh workflow run platform-credential-health.yml --ref main");
    expect(result.stdout).toContain("gh workflow run platform-digitalocean-drift-digest.yml --ref main");
  });
});

describe("AC1: a value reaches only gh's stdin", () => {
  it("keeps a sentinel pair out of every argv, child environment, stdout and stderr", async () => {
    const result = await rotate(["--secret", "PAIR_ACCESS_ID"], { stdin: pipedStdin([SENTINEL, SENTINEL_PARTNER]) });
    expect(result.code).toBe(0);
    expect(gh.forbidden).toEqual([]);
    expect(gh.calls.length).toBe(8 + 2);
    for (const call of gh.calls) {
      expect(call.command).toBe("gh");
      expect(call.options.shell ?? false).toBe(false);
      for (const value of [SENTINEL, SENTINEL_PARTNER]) {
        expect(call.args.join("\n")).not.toContain(value);
        expect(JSON.stringify(call.options.env ?? process.env)).not.toContain(value);
      }
    }
    for (const value of [SENTINEL, SENTINEL_PARTNER]) {
      expect(JSON.stringify(process.env)).not.toContain(value);
      expect(result.output).not.toContain(value);
    }
    for (const call of secretSets()) {
      expect(call.stdin).toBe(call.args[2] === "PAIR_ACCESS_ID" ? SENTINEL : SENTINEL_PARTNER);
    }
    for (const call of workflowRuns()) expect(call.stdin).toBeNull();
  });

  it("redacts the value from a failed gh's stderr and names only the secret and target", async () => {
    respondWithRunUrls((call) =>
      call.args[0] === "secret" ? { code: 1, stderr: `HTTP 422: rejected body ${SENTINEL}\n` } : undefined,
    );
    const result = await rotate(["--secret", "FORMAT_TOKEN"]);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(SENTINEL);
    expect(result.stderr).toContain("gh secret set FORMAT_TOKEN --env staging failed (exit 1)");
    expect(result.stderr).toContain("[redacted]");
  });

  it("reads TTY input in raw mode, so nothing is echoed, and restores the terminal", async () => {
    const stdin = ttyStdin(`${SENTINEL}\r`);
    const result = await rotate(["--secret", "FORMAT_TOKEN"], { stdin });
    expect(result.code).toBe(0);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(result.stderr).toContain("New value for FORMAT_TOKEN");
    expect(result.output).not.toContain(SENTINEL);
    expect(secretSets()[0].stdin).toBe(SENTINEL);
  });

  it("prompts a pair in order, named secret first, and honours backspace", async () => {
    const stdin = ttyStdin(`${SENTINEL}x\u007f\r${SENTINEL_PARTNER}\r`);
    const result = await rotate(["--secret", "PAIR_SECRET_KEY"], { stdin });
    expect(result.code).toBe(0);
    expect(result.stderr.indexOf("New value for PAIR_SECRET_KEY")).toBeLessThan(
      result.stderr.indexOf("New value for PAIR_ACCESS_ID"),
    );
    expect(secretSets()[0]).toMatchObject({ args: ["secret", "set", "PAIR_SECRET_KEY", "--env", "merge-gate"] });
    expect(secretSets()[0].stdin).toBe(SENTINEL);
    expect(secretSets()[1].stdin).toBe(SENTINEL_PARTNER);
  });

  it("cancels on Ctrl+C before any write", async () => {
    const stdin = ttyStdin(`${SENTINEL}\u0003`);
    const result = await rotate(["--secret", "FORMAT_TOKEN"], { stdin });
    expect(result.code).toBe(1);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(gh.calls).toEqual([]);
    expect(result.output).not.toContain(SENTINEL);
  });

  it("never echoes an unexpected argument, which may be a mistyped value", async () => {
    const result = await rotate(["--secret", "FORMAT_TOKEN", SENTINEL]);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(SENTINEL);
    const misplaced = await rotate(["--secret", SENTINEL]);
    expect(misplaced.code).toBe(1);
    expect(misplaced.output).not.toContain(SENTINEL);
    const misplacedEnv = await rotate(["--secret", "STRIPE_LIKE_SECRET", "--env", SENTINEL.toLowerCase()]);
    expect(misplacedEnv.code).toBe(1);
    expect(misplacedEnv.output).not.toContain(SENTINEL.toLowerCase());
    expect(gh.calls).toEqual([]);
  });
});

describe("AC2: writes follow the selected value group", () => {
  it("writes both halves of a four-environment pair to each environment in inventory order", async () => {
    const result = await rotate(["--secret", "PAIR_ACCESS_ID"], { stdin: pipedStdin([SENTINEL, SENTINEL_PARTNER]) });
    expect(result.code).toBe(0);
    expect(writeOrder()).toEqual(
      ENVIRONMENTS.flatMap((environment) => [`PAIR_ACCESS_ID@${environment}`, `PAIR_SECRET_KEY@${environment}`]),
    );
    for (const call of secretSets()) {
      expect(call.args).toEqual(["secret", "set", call.args[2], "--env", call.args[4]]);
      expect(call.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    }
  });

  it.each([
    ["the first half", "PAIR_ACCESS_ID"],
    ["the second half", "PAIR_SECRET_KEY"],
  ])(
    "stops when %s of the third environment's write fails and names the two completed environments",
    async (_label, failing) => {
      respondWithRunUrls((call) =>
        call.args[0] === "secret" && call.args[2] === failing && call.args[4] === "production"
          ? { code: 1 }
          : undefined,
      );
      const result = await rotate(["--secret", "PAIR_ACCESS_ID"], { stdin: pipedStdin([SENTINEL, SENTINEL_PARTNER]) });
      expect(result.code).toBe(1);
      const expected = ["PAIR_ACCESS_ID@merge-gate", "PAIR_SECRET_KEY@merge-gate", "PAIR_ACCESS_ID@preview"];
      expected.push("PAIR_SECRET_KEY@preview", "PAIR_ACCESS_ID@production");
      if (failing === "PAIR_SECRET_KEY") expected.push("PAIR_SECRET_KEY@production");
      expect(writeOrder()).toEqual(expected);
      expect(result.stderr).toContain("Targets already holding the new value: merge-gate, preview.");
      if (failing === "PAIR_SECRET_KEY") {
        expect(result.stderr).toContain("production holds the new PAIR_ACCESS_ID but not PAIR_SECRET_KEY.");
        expect(result.stderr).toContain("Not written: staging.");
      } else {
        expect(result.stderr).not.toContain("production holds");
        expect(result.stderr).toContain("Not written: production, staging.");
      }
      expect(result.stderr).toContain("rerun with the same values");
      expect(workflowRuns()).toEqual([]);
      expect(result.output).not.toContain(SENTINEL);
    },
  );

  it("refuses a multi-group entry without --env before any prompt", async () => {
    const stdin = ttyStdin(`${SENTINEL}\r`);
    const result = await rotate(["--secret", "STRIPE_LIKE_SECRET"], { stdin });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--env is required");
    expect(result.stderr).toContain("[merge-gate] [preview] [production] [staging]");
    expect(stdin.rawModes).toEqual([]);
    expect(result.stderr).not.toContain("New value");
    expect(gh.calls).toEqual([]);
  });

  it("writes --env staging only to staging, both halves of the pair", async () => {
    const result = await rotate(["--secret", "STRIPE_LIKE_SECRET", "--env", "staging"], {
      stdin: pipedStdin([SENTINEL, SENTINEL_PARTNER]),
    });
    expect(result.code).toBe(0);
    expect(writeOrder()).toEqual(["STRIPE_LIKE_SECRET@staging", "STRIPE_LIKE_PUBLISHABLE@staging"]);
  });

  it.each([
    ["spans two value groups", ["--secret", "STRIPE_LIKE_SECRET", "--env", "staging,production"]],
    ["is a subset of a value group", ["--secret", "PAIR_ACCESS_ID", "--env", "staging,production"]],
    ["is a superset of a value group", ["--secret", "MIXED_PRIMARY", "--env", "preview,production,staging"]],
    ["repeats an environment", ["--secret", "PAIR_ACCESS_ID", "--env", "merge-gate,preview,production,production"]],
    ["has an empty member", ["--secret", "STRIPE_LIKE_SECRET", "--env", "staging,"]],
    ["is given for a repository-scoped entry", ["--secret", "REPO_TOKEN", "--env", "staging"]],
  ])("refuses an --env set that %s before any prompt", async (_label, argv) => {
    const stdin = ttyStdin(`${SENTINEL}\r`);
    const result = await rotate(argv, { stdin });
    expect(result.code).toBe(1);
    expect(stdin.rawModes).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("accepts --env in any order when it equals a value group, writing in inventory order", async () => {
    const result = await rotate(["--secret", "PAIR_ACCESS_ID", "--env", "staging,production,preview,merge-gate"], {
      stdin: pipedStdin([SENTINEL, SENTINEL_PARTNER]),
    });
    expect(result.code).toBe(0);
    expect(writeOrder().filter((target) => target.startsWith("PAIR_ACCESS_ID"))).toEqual(
      ENVIRONMENTS.map((environment) => `PAIR_ACCESS_ID@${environment}`),
    );
  });

  it("refuses a pair whose partner does not share the selected value group", async () => {
    const result = await rotate(["--secret", "MIXED_PRIMARY"], { stdin: pipedStdin([SENTINEL, SENTINEL_PARTNER]) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("MIXED_PARTNER does not share value group [production, staging]");
    expect(gh.calls).toEqual([]);
  });

  it("writes a repository-scoped entry to the repository without --env", async () => {
    const result = await rotate(["--secret", "REPO_TOKEN"]);
    expect(result.code).toBe(0);
    expect(secretSets().map((call) => call.args)).toEqual([["secret", "set", "REPO_TOKEN"]]);
  });

  it("refuses stdin that does not carry exactly one line per value", async () => {
    const result = await rotate(["--secret", "PAIR_ACCESS_ID"], { stdin: pipedStdin([SENTINEL]) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "stdin is not a terminal; reading one value per line for PAIR_ACCESS_ID, PAIR_SECRET_KEY.",
    );
    expect(result.stderr).toContain("exactly 2 lines");
    expect(gh.calls).toEqual([]);
  });
});

describe("AC3: validation finishes before the first write", () => {
  it.each([
    ["dead (DigitalOcean 401)", async () => new Response("", { status: 401 }), "dead (http-401)"],
    [
      "unknown (network error)",
      async () => {
        throw new TypeError("fetch failed");
      },
      "unknown (network-error)",
    ],
    ["unknown (DigitalOcean 403)", async () => new Response("", { status: 403 }), "unknown (http-403)"],
  ])("refuses a value whose liveness is %s", async (_label, fetch, verdict) => {
    const result = await rotate(["--secret", "DO_TOKEN"], { fetch });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`DO_TOKEN liveness digitalocean-account is ${verdict}`);
    expect(result.stderr).toContain("nothing was written");
    expect(gh.calls).toEqual([]);
    expect(result.output).not.toContain(SENTINEL);
  });

  it("refuses an empty liveness value without a request", async () => {
    const live = liveFetch();
    const result = await rotate(["--secret", "DO_TOKEN"], { stdin: pipedStdin([""]), fetch: live.fetch });
    expect(result.code).toBe(1);
    expect(live.requests).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("checks the new DigitalOcean token against /v2/account before writing it", async () => {
    const live = liveFetch();
    const result = await rotate(["--secret", "DO_TOKEN"], { fetch: live.fetch });
    expect(result.code).toBe(0);
    expect(live.requests).toEqual([
      { url: "https://api.digitalocean.com/v2/account", authorization: `Bearer ${SENTINEL}` },
    ]);
  });

  it("validates a Spaces pair together, signing with the new access key, whichever half is named", async () => {
    const live = liveFetch();
    const result = await rotate(["--secret", "PAIR_SECRET_KEY"], {
      stdin: pipedStdin([SENTINEL_PARTNER, SENTINEL]),
      fetch: live.fetch,
    });
    expect(result.code).toBe(0);
    expect(live.requests).toHaveLength(1);
    expect(live.requests[0].authorization).toContain(`Credential=${SENTINEL}/`);
    const dead = await rotate(["--secret", "PAIR_ACCESS_ID"], {
      stdin: pipedStdin([SENTINEL, SENTINEL_PARTNER]),
      fetch: async () => new Response("<Error><Code>InvalidAccessKeyId</Code></Error>", { status: 403 }),
    });
    expect(dead.code).toBe(1);
    expect(dead.stderr).toContain("PAIR_ACCESS_ID liveness spaces-list-buckets is dead (invalid-access-key-id)");
  });

  it.each([
    ["empty", ""],
    ["containing a space", "two words"],
    ["containing a tab", "tab\there"],
    ["containing a carriage return", "line\rbreak"],
  ])("refuses a value without a liveness kind that is %s", async (_label, value) => {
    const result = await rotate(["--secret", "FORMAT_TOKEN"], { stdin: pipedStdin([value]) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FORMAT_TOKEN must be non-empty with no whitespace or line breaks");
    expect(gh.calls).toEqual([]);
  });

  it("refuses a pair when either half fails validation, writing neither", async () => {
    const result = await rotate(["--secret", "STRIPE_LIKE_SECRET", "--env", "staging"], {
      stdin: pipedStdin([SENTINEL, "has space"]),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("STRIPE_LIKE_PUBLISHABLE must be non-empty");
    expect(gh.calls).toEqual([]);
  });
});

describe("AC4: proof dispatch and --dry-run", () => {
  it("dispatches every proof workflow of the pair on main after the writes and prints each run URL", async () => {
    const result = await rotate(["--secret", "PAIR_ACCESS_ID"], { stdin: pipedStdin([SENTINEL, SENTINEL_PARTNER]) });
    expect(result.code).toBe(0);
    expect(workflowRuns().map((call) => call.args)).toEqual([
      ["workflow", "run", "platform-credential-health.yml", "--ref", "main"],
      ["workflow", "run", "representative-catalog-snapshot.yml", "--ref", "main"],
    ]);
    expect(gh.calls.findIndex((call) => call.args[0] === "workflow")).toBe(8);
    expect(result.stdout).toContain(`platform-credential-health.yml on main: ${RUN_URL}1001`);
    expect(result.stdout).toContain(`representative-catalog-snapshot.yml on main: ${RUN_URL}1002`);
    expect(result.stdout).toContain("delete the old PAIR_ACCESS_ID and PAIR_SECRET_KEY at the provider");
  });

  it("reports a dispatch with no run URL as failed and never invents one", async () => {
    respondWithRunUrls((call) =>
      call.args[2] === "platform-digitalocean-drift-digest.yml"
        ? { stdout: "Created workflow_dispatch event\n" }
        : undefined,
    );
    const result = await rotate(["--secret", "DO_TOKEN"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`platform-credential-health.yml on main: ${RUN_URL}1001`);
    expect(result.stderr).toContain("platform-digitalocean-drift-digest.yml: gh returned no run URL");
    expect(result.output.match(/actions\/runs\/\d+/g)).toEqual(["actions/runs/1001"]);
  });

  it("reports a failed dispatch command as failed", async () => {
    respondWithRunUrls((call) => (call.args[0] === "workflow" ? { code: 1, stderr: "HTTP 403\n" } : undefined));
    const result = await rotate(["--secret", "REPO_TOKEN"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("gh workflow run project-status-sync.yml --ref main failed (exit 1)");
    expect(result.output).not.toContain(RUN_URL);
  });

  it("dry-run prints targets, validation and workflows without prompting, reading or spawning", async () => {
    const stdin = ttyStdin(`${SENTINEL}\r`);
    const live = liveFetch();
    const result = await rotate(["--secret", "PAIR_ACCESS_ID", "--dry-run"], { stdin, fetch: live.fetch });
    expect(result.code).toBe(0);
    expect(gh.calls).toEqual([]);
    expect(stdin.rawModes).toEqual([]);
    expect(live.requests).toEqual([]);
    expect(result.stderr).toBe("");
    for (const environment of ENVIRONMENTS) {
      expect(result.stdout).toContain(`gh secret set PAIR_ACCESS_ID --env ${environment}`);
      expect(result.stdout).toContain(`gh secret set PAIR_SECRET_KEY --env ${environment}`);
    }
    expect(result.stdout).toContain("gh workflow run representative-catalog-snapshot.yml --ref main");
    expect(result.stdout).toContain("PAIR_ACCESS_ID: liveness spaces-list-buckets");
    expect(result.stdout).toContain("PAIR_SECRET_KEY: non-empty, no whitespace or line breaks");
  });

  it("dry-run still refuses a multi-group entry without --env", async () => {
    const result = await rotate(["--secret", "STRIPE_LIKE_SECRET", "--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--env is required");
  });
});

describe("AC5: only assisted credentials rotate here", () => {
  it.each([
    ["AUTOMATIC_TOKEN", "AUTOMATIC_TOKEN has rotation automatic; its owner is the automatic rotation tooling"],
    ["COOKIE", "COOKIE has rotation external-owner; its owner is issue #8447"],
    [
      "TIED_TO_AUTOMATIC",
      "TIED_TO_AUTOMATIC_PARTNER has rotation automatic; its owner is the automatic rotation tooling",
    ],
  ])("refuses %s with its owner named, before any prompt", async (secret, message) => {
    const stdin = ttyStdin(`${SENTINEL}\r`);
    const result = await rotate(["--secret", secret], { stdin });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(stdin.rawModes).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("refuses an external-owner entry in dry-run too", async () => {
    const result = await rotate(["--secret", "COOKIE", "--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("its owner is issue #8447");
  });

  it("refuses a name with no inventory entry without echoing it", async () => {
    const result = await rotate(["--secret", "NOT_INVENTORIED"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--secret does not name a credential inventory entry");
    expect(result.output).not.toContain("NOT_INVENTORIED");
  });
});
