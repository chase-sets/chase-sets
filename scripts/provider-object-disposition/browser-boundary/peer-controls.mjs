import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = "/usr/local/lib/chase-sets-provider-window-input/scripts/provider-object-disposition/browser-boundary/";
const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };

export async function withPeerHolder(owner, test) {
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && Number.isSafeInteger(owner.start) && owner.start > 0);
  const execution = execute("/usr/bin/python3", [root + "peer-observe.py", "hold", `${owner.pid}:${owner.start}`], {
    env,
    timeout: 5000,
    maxBuffer: 4096,
  });
  let prefix = "";
  const ready = new Promise((resolve, reject) => {
    execution.child.stdout.on("data", (chunk) => {
      prefix += chunk.toString("utf8");
      if (prefix.includes("\n")) {
        try {
          resolve(JSON.parse(prefix.slice(0, prefix.indexOf("\n"))));
        } catch {
          reject(new Error("peer-holder-invalid"));
        }
      }
    });
    void execution.then(() => reject(new Error("peer-holder-ended")), reject);
  });
  let primary;
  let constructed = false;
  try {
    const value = await ready;
    if (value.constructed === false) {
      assert.deepEqual(Object.keys(value).sort(), ["constructed", "reason"]);
      assert.ok(["EACCES", "EPERM", "ESRCH", "ENOENT", "unknown"].includes(value.reason));
      console.log(`installed-boundary control 15 peer holder: NOT CONSTRUCTED; ${value.reason}`);
    } else {
      assert.equal(value.constructed, true);
      assert.deepEqual(Object.keys(value).sort(), ["constructed", "device", "inode", "pid", "start"]);
      for (const key of ["device", "inode", "pid", "start"])
        assert.ok(Number.isSafeInteger(value[key]) && value[key] > 0);
      constructed = true;
      await test(value);
      const { stdout, stderr } = await execute(
        "/usr/bin/python3",
        [root + "peer-observe.py", "census", `${value.device}:${value.inode}`],
        { env, timeout: 3000, maxBuffer: 16384 },
      );
      assert.equal(stderr, "");
      const observed = JSON.parse(stdout);
      assert.equal(observed.complete, true);
      assert.ok(observed.peerHolders.some((record) => record.pid === value.pid && record.start === value.start));
      console.log(
        `installed-boundary control 15 B-H1 held after owned drain:${JSON.stringify(observed)}; namespaceReclamation=not-claimed`,
      );
    }
  } catch (error) {
    primary = error;
  } finally {
    execution.child.stdin.end();
    try {
      const { stdout, stderr } = await execution;
      assert.equal(stderr, "");
      assert.equal(
        stdout.slice(stdout.indexOf("\n") + 1),
        constructed ? "provider-boundary-peer-holder:released;namespace-valid=true\n" : "",
      );
    } catch (error) {
      primary ??= error;
    }
  }
  if (primary) throw primary;
  return constructed;
}

export async function peerControls(owners) {
  const pairs = owners.map(({ pid, start }) => `${pid}:${start}`).join(",");
  const namespaceResult = await execute(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/python3", root + "native-variants.py", "namespaces", pairs],
    {
      env,
      timeout: 1000,
      maxBuffer: 16384,
    },
  );
  assert.equal(namespaceResult.stderr, "");
  const identities = JSON.parse(namespaceResult.stdout);
  assert.ok(identities.namespaces.length > 0);
  const observed = await execute("/usr/bin/python3", [root + "peer-observe.py", "reach", pairs], {
    env,
    timeout: 1000,
    maxBuffer: 16384,
  });
  assert.equal(observed.stderr, "");
  const reach = JSON.parse(observed.stdout);
  assert.equal(reach.length, owners.length);
  assert.ok(reach.every((record) => ["readable", "gone", "EACCES", "EPERM", "unknown"].includes(record.observation)));
  console.log(`installed-boundary control 7 same-UID peer reach:${JSON.stringify(reach)}`);
  return async () => {
    const held = await execute(
      "/usr/bin/python3",
      [root + "peer-observe.py", "census", identities.namespaces.map((pair) => pair.join(":")).join(",")],
      {
        env,
        timeout: 3000,
        maxBuffer: 16384,
      },
    );
    assert.equal(held.stderr, "");
    const census = JSON.parse(held.stdout);
    const ownedHolders = census.peerHolders.filter((holder) =>
      owners.some((owner) => owner.pid === holder.pid && owner.start === holder.start),
    );
    console.log(
      `installed-boundary control 15 holder census:${JSON.stringify({ ...census, captureUnknown: identities.unknown, ownedHolders, namespaceReclamation: "not-claimed", residual: "B-H1" })}`,
    );
    assert.deepEqual(ownedHolders, []);
    assert.equal(census.complete, true);
  };
}
