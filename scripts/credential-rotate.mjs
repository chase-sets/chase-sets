#!/usr/bin/env node
// Assisted credential rotation: validate a new value, write it to every target
// of one value group, then dispatch the entry's proof workflows on main. Terms
// are defined in docs/runbooks/credential-rotation.md.
//
// A value reaches only `gh`'s stdin and the in-process liveness check. It never
// enters argv, a child environment, stdout, stderr, an error message or a file,
// and the command spawns nothing but `gh`. Authority is the operator's own `gh`
// login, never the rotation App.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkCredentialLiveness } from "./credential-health.mjs";
import { REPOSITORY_SCOPE, SPACES_LIVENESS_KINDS, loadCredentialInventory } from "./credential-inventory.mjs";

export const PROOF_REF = "main";
const USAGE = "usage: credential-rotate.mjs --secret <NAME> [--env <name>[,<name>...]] [--dry-run]";
const RUN_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/;
const MAX_STDIN_BYTES = 256 * 1024;
const MAX_CHILD_OUTPUT = 64 * 1024;
const FORMAT_RULE = "non-empty, no whitespace or line breaks";

// Errors whose message is safe to print: they name only options, inventoried
// secret and environment names, value groups, owners and verdicts.
class RotationError extends Error {}

function sameMembers(left, right) {
  return left.length === right.length && left.every((member) => right.includes(member));
}

function groupLabel(group) {
  return `[${group.join(", ")}]`;
}

function targetLabel(target) {
  return target === REPOSITORY_SCOPE ? "" : ` --env ${target}`;
}

function secretSetArgs(name, target) {
  return ["secret", "set", name, ...(target === REPOSITORY_SCOPE ? [] : ["--env", target])];
}

function workflowRunArgs(workflow) {
  return ["workflow", "run", workflow, "--ref", PROOF_REF];
}

// Unrecognised arguments are refused by position, never echoed: a value pasted
// onto the command line must not be printed back.
export function parseRotateArgs(argv) {
  const parsed = { secret: null, envs: null, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inline] = argument.startsWith("--") && argument.includes("=") ? argument.split(/=(.*)/s) : [argument];
    const take = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new RotationError(`${flag} needs a value`);
      return argv[index];
    };
    if (flag === "--secret" && parsed.secret === null) parsed.secret = take();
    else if (flag === "--env" && parsed.envs === null) parsed.envs = take().split(",");
    else if (flag === "--dry-run" && inline === undefined) parsed.dryRun = true;
    else if ((flag === "--help" || flag === "-h") && inline === undefined) parsed.help = true;
    else throw new RotationError(`unexpected argument at position ${index + 1}; ${USAGE}`);
  }
  if (!parsed.help && !parsed.secret) throw new RotationError(`--secret is required; ${USAGE}`);
  return parsed;
}

function refuseUnlessAssisted(entry) {
  if (entry.rotation === "automatic") {
    throw new RotationError(
      `${entry.name} has rotation automatic; its owner is the automatic rotation tooling, so credential:rotate refuses it`,
    );
  }
  if (entry.rotation === "external-owner") {
    throw new RotationError(
      `${entry.name} has rotation external-owner; its owner is issue #${entry.owner}, so credential:rotate refuses it`,
    );
  }
}

function selectValueGroup(inventory, entry, envs) {
  const groups = entry.valueGroups;
  if (sameMembers(entry.scope, [REPOSITORY_SCOPE])) {
    if (envs !== null) throw new RotationError(`${entry.name} is repository-scoped and takes no --env`);
    return groups[0];
  }
  if (envs === null) {
    if (groups.length > 1) {
      throw new RotationError(
        `--env is required: ${entry.name} has ${groups.length} value groups ${groups.map(groupLabel).join(" ")}`,
      );
    }
    return groups[0];
  }
  if (envs.some((name) => !inventory.scopes.includes(name))) {
    throw new RotationError("--env names an environment outside the credential inventory");
  }
  if (new Set(envs).size !== envs.length) throw new RotationError("--env repeats an environment");
  const group = groups.find((candidate) => sameMembers(candidate, envs));
  if (!group) {
    throw new RotationError(
      `--env must equal exactly one value group of ${entry.name}: ${groups.map(groupLabel).join(" ")}`,
    );
  }
  return group;
}

// The rotation plan: the pair's members in prompt order (named secret first),
// the selected value group's targets in inventory order, each member's
// validation, and the pair's proof workflows. Nothing here reads a value.
export function planRotation(inventory, { secret, envs }) {
  const entry = inventory.byName.get(secret);
  if (!entry) throw new RotationError("--secret does not name a credential inventory entry");
  const members = [entry, ...entry.pairedWith.map((name) => inventory.byName.get(name))];
  for (const member of members) refuseUnlessAssisted(member);
  const names = members.map((member) => member.name);
  for (const member of members) {
    const outside = member.pairedWith.filter((name) => !names.includes(name));
    if (outside.length > 0) {
      throw new RotationError(`${member.name} pairs with ${outside.join(", ")} outside the pair of ${entry.name}`);
    }
  }
  const targets = selectValueGroup(inventory, entry, envs);
  for (const partner of members.slice(1)) {
    if (!partner.valueGroups.some((group) => sameMembers(group, targets))) {
      throw new RotationError(`${partner.name} does not share value group ${groupLabel(targets)} with ${entry.name}`);
    }
  }
  return {
    members: members.map((member) => ({ name: member.name, liveness: member.liveness, pairedWith: member.pairedWith })),
    targets,
    proofWorkflows: [...new Set(members.flatMap((member) => member.proofWorkflows))],
  };
}

function validationLabel(member) {
  return member.liveness ? `liveness ${member.liveness.kind}` : FORMAT_RULE;
}

// D2: every value is non-empty; a member without its own liveness kind also has
// no whitespace or line breaks; a member with one must be `live`. The whole pair
// is validated before the first write.
async function validateValues(plan, values, options) {
  for (const member of plan.members) {
    const value = values.get(member.name);
    if (value === "" || (!member.liveness && /\s/u.test(value))) {
      throw new RotationError(
        `${member.name} must be non-empty with no whitespace or line breaks; nothing was written`,
      );
    }
  }
  for (const member of plan.members) {
    if (!member.liveness) continue;
    const { kind, bucket } = member.liveness;
    const credentials = SPACES_LIVENESS_KINDS.includes(kind)
      ? { accessKeyId: values.get(member.name), secretAccessKey: values.get(member.pairedWith[0]), bucket }
      : { token: values.get(member.name) };
    const result = await checkCredentialLiveness(kind, credentials, { fetch: options.fetch });
    if (result.verdict !== "live") {
      throw new RotationError(
        `${member.name} liveness ${kind} is ${result.verdict} (${result.reason}); nothing was written`,
      );
    }
  }
}

async function readStdin(stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_STDIN_BYTES) throw new RotationError(`stdin exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// One raw-mode session for every prompt, so nothing is echoed and a pasted
// pair split by Enter lands in order. The terminal is restored on every exit.
function promptHidden(names, { stdin, stderr }) {
  return new Promise((resolvePrompt, rejectPrompt) => {
    const values = [];
    let current = "";
    const finish = (error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (error) rejectPrompt(error);
      else resolvePrompt(values);
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\u0003" || char === "\u0004")
          return finish(new RotationError("prompt cancelled; nothing was written"));
        if (char === "\r" || char === "\n") {
          values.push(current);
          current = "";
          if (values.length === names.length) return finish();
          stderr.write(`\nNew value for ${names[values.length]} (input hidden): `);
        } else if (char === "\u007f" || char === "\b") {
          current = Array.from(current).slice(0, -1).join("");
        } else if (char >= " ") {
          current += char;
        }
      }
      return undefined;
    };
    stderr.write(`New value for ${names[0]} (input hidden): `);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function readValues(names, io) {
  if (io.stdin.isTTY) {
    return new Map((await promptHidden(names, io)).map((value, index) => [names[index], value]));
  }
  // A terminal that is not a TTY to Node (Git Bash mintty) echoes typing, so
  // say plainly that input is read from stdin rather than prompted.
  io.stderr.write(`stdin is not a terminal; reading one value per line for ${names.join(", ")}.\n`);
  const lines = (await readStdin(io.stdin)).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== names.length) {
    throw new RotationError(
      `stdin must carry exactly ${names.length} line${names.length === 1 ? "" : "s"}, one value each for ${names.join(", ")}; got ${lines.length}`,
    );
  }
  return new Map(lines.map((value, index) => [names[index], value]));
}

function redact(text, values) {
  let result = text;
  for (const value of [...values].sort((left, right) => right.length - left.length)) {
    if (value) result = result.split(value).join("[redacted]");
  }
  return result;
}

// Runs `gh` without a shell. `input` is the only route a value takes, on stdin;
// the child environment is the operator's own, which holds no value.
function runGh(args, { input = null, env, spawnImpl = spawn }) {
  return new Promise((resolveRun) => {
    const output = { stdout: "", stderr: "" };
    let child;
    try {
      child = spawnImpl("gh", args, {
        stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
        env,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolveRun({ ok: false, reason: error?.code ?? "spawn-failed", ...output });
      return;
    }
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolveRun({ ...result, ...output });
    };
    for (const stream of ["stdout", "stderr"]) {
      child[stream]?.on("data", (chunk) => {
        if (output[stream].length < MAX_CHILD_OUTPUT) output[stream] += String(chunk);
      });
    }
    child.on("error", (error) => settle({ ok: false, reason: error?.code ?? "spawn-failed" }));
    child.on("close", (code, signal) =>
      settle(signal || code !== 0 ? { ok: false, reason: signal ? `signal ${signal}` : `exit ${code}` } : { ok: true }),
    );
    if (input !== null) {
      child.stdin.on("error", (error) => settle({ ok: false, reason: error?.code ?? "stdin-failed" }));
      child.stdin.end(input);
    }
  });
}

function writeGhFailure(io, command, result, values) {
  io.stderr.write(`${command} failed (${result.reason}).\n`);
  const detail = redact(result.stderr, values).trim().split(/\r?\n/).slice(-5).join("\n");
  if (detail) io.stderr.write(`gh: ${detail}\n`);
}

function renderDryRun(plan, io) {
  const lines = [
    `credential:rotate dry run: no prompt, no validation request, no write, no dispatch.`,
    `Values, prompted in this order and validated together before any write:`,
    ...plan.members.map((member) => `  ${member.name}: ${validationLabel(member)}`),
    `Writes, in order, stopping at the first failure:`,
    ...plan.targets.flatMap((target) =>
      plan.members.map((member) => `  gh secret set ${member.name}${targetLabel(target)}`),
    ),
    `Proof workflows, dispatched after every write succeeds:`,
    ...(plan.proofWorkflows.length > 0
      ? plan.proofWorkflows.map((workflow) => `  gh workflow run ${workflow} --ref ${PROOF_REF}`)
      : ["  none inventoried"]),
    followUp(plan),
  ];
  io.stdout.write(`${lines.join("\n")}\n`);
}

function nameList(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

function followUp(plan) {
  const names = nameList(plan.members.map((member) => member.name));
  return plan.proofWorkflows.length > 0
    ? `Follow-up: once every proof run passes, delete the old ${names} at the provider.`
    : `Follow-up: no proof workflow is inventoried; confirm the consumers of ${names}, then delete the old value at the provider.`;
}

// Returns the exit code. `options` carries injectable io, `fetch` for the
// liveness check, and `inventory` (defaulting to the checked-in one).
export async function runCredentialRotate(argv, options = {}) {
  const io = {
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
  try {
    const parsed = parseRotateArgs(argv);
    if (parsed.help) {
      io.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const inventory = options.inventory ?? loadInventory(options.repositoryRoot);
    const plan = planRotation(inventory, parsed);
    if (parsed.dryRun) {
      renderDryRun(plan, io);
      return 0;
    }
    const names = plan.members.map((member) => member.name);
    const values = await readValues(names, io);
    await validateValues(plan, values, options);
    const secretValues = [...values.values()];
    const env = options.env ?? process.env;

    const completed = [];
    for (const [targetIndex, target] of plan.targets.entries()) {
      const written = [];
      for (const name of names) {
        const result = await runGh(secretSetArgs(name, target), {
          input: values.get(name),
          env,
          spawnImpl: options.spawn,
        });
        if (!result.ok) {
          writeGhFailure(io, `gh secret set ${name}${targetLabel(target)}`, result, secretValues);
          io.stderr.write(`Targets already holding the new value: ${completed.join(", ") || "none"}.\n`);
          if (written.length > 0) {
            const missing = names.filter((member) => !written.includes(member));
            io.stderr.write(`${target} holds the new ${written.join(", ")} but not ${missing.join(", ")}.\n`);
          }
          const untouched = plan.targets.slice(written.length > 0 ? targetIndex + 1 : targetIndex);
          io.stderr.write(`Not written: ${untouched.join(", ") || "none"}.\n`);
          io.stderr.write("Proof workflows were not dispatched; rerun with the same values to complete the set.\n");
          return 1;
        }
        written.push(name);
      }
      completed.push(target);
      io.stdout.write(`Wrote ${nameList(names)} to ${target}.\n`);
    }

    let dispatchFailed = false;
    for (const workflow of plan.proofWorkflows) {
      const command = `gh workflow run ${workflow} --ref ${PROOF_REF}`;
      const result = await runGh(workflowRunArgs(workflow), { env, spawnImpl: options.spawn });
      if (!result.ok) {
        writeGhFailure(io, command, result, secretValues);
        dispatchFailed = true;
        continue;
      }
      const url = RUN_URL.exec(redact(result.stdout, secretValues))?.[0];
      if (!url) {
        io.stderr.write(`${workflow}: gh returned no run URL; treat this proof as not dispatched.\n`);
        dispatchFailed = true;
        continue;
      }
      io.stdout.write(`Dispatched ${workflow} on ${PROOF_REF}: ${url}\n`);
    }
    io.stdout.write(`${followUp(plan)}\n`);
    return dispatchFailed ? 1 : 0;
  } catch (error) {
    // Only RotationError messages are known to be value-free.
    const message = error instanceof RotationError ? error.message : `failed (${error?.name ?? "Error"})`;
    io.stderr.write(`credential:rotate: ${message}\n`);
    return 1;
  }
}

function loadInventory(root = process.cwd()) {
  try {
    return loadCredentialInventory(root);
  } catch (error) {
    throw new RotationError(error.message);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCredentialRotate(process.argv.slice(2));
}
