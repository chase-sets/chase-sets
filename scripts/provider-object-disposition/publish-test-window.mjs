import { createHash } from "node:crypto";
import { readFile, realpath, lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, relative, resolve, isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validateCapturePacket } from "./test-window-packet.mjs";
import { REPOSITORY_ROOT, validateLaunchManifest } from "./test-window-admission.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function publishCapturePacket(packet, manifestPath, manifestDigest) {
  if (!validateCapturePacket(packet) || packet.manifestDigest !== manifestDigest || !isAbsolute(manifestPath))
    throw new Error("packet-invalid");
  const bytes = await readFile(manifestPath);
  if (bytes.byteLength > 32768 || hash(bytes) !== manifestDigest) throw new Error("packet-invalid");
  const manifest = JSON.parse(bytes.toString("utf8"));
  // Publication is allowed after authority expiry, not another provider operation.
  validateLaunchManifest(manifest, manifest.heads.candidate, Date.parse(manifest.timing.startsAt));
  if (
    packet.heads &&
    (JSON.stringify(packet.heads) !== JSON.stringify(manifest.heads) ||
      packet.configDigest !== manifest.configuration.configDigest ||
      packet.policyDigest !== manifest.configuration.policyDigest)
  )
    throw new Error("packet-invalid");
  const destination = manifest.paths.packetDirectory;
  const parent = await realpath(dirname(destination));
  const parentStat = await lstat(dirname(destination));
  const within = relative(REPOSITORY_ROOT, destination);
  if (
    resolve(destination) !== join(parent, relative(dirname(destination), destination)) ||
    !(within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) ||
    destination.startsWith("\\\\") ||
    parentStat.isSymbolicLink() ||
    (process.platform === "linux" && (parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0))
  )
    throw new Error("packet-invalid");
  try {
    await lstat(destination);
    throw new Error("packet-exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.partial`;
  await mkdir(temporary, { mode: 0o700 });
  const payload = Buffer.from(JSON.stringify(packet));
  const digest = hash(payload);
  for (const [name, content] of [
    ["packet.json", payload],
    ["sha256.txt", Buffer.from(digest)],
  ]) {
    const file = await open(join(temporary, name), "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  await rename(temporary, destination);
  return { classification: packet.classification, packetDigest: digest, replayQualified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error("packet-invalid");
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 1048576) throw new Error("packet-invalid");
      chunks.push(chunk);
    }
    const result = await publishCapturePacket(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      process.argv[2],
      process.argv[3],
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stdout.write('{"classification":"invalid","code":"packet-invalid","replayQualified":false}\n');
    process.exitCode = 2;
  }
}
