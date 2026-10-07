import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = "/usr/local/lib/chase-sets-provider-window-input/scripts/provider-object-disposition/browser-boundary/";
const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };

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
