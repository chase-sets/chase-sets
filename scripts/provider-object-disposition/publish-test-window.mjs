import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { realpath, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonNoDuplicateKeys } from "./validate-provider-object-disposition.mjs";
import { parseCapturePacket, validateCapturePacket } from "./test-window-packet.mjs";
import { REPOSITORY_ROOT } from "./test-window-admission.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function publicationContext(path, digest) {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("packet-invalid");
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > 32768 ||
    (await realpath(path)) !== path ||
    (process.platform === "linux" && (before.uid !== process.getuid() || (before.mode & 0o077) !== 0))
  )
    throw new Error("packet-invalid");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const buffer = Buffer.alloc(32769);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytesRead !== before.size)
      throw new Error("packet-invalid");
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  if (hash(bytes) !== digest) throw new Error("packet-invalid");
  const manifest = parseJsonNoDuplicateKeys(bytes.toString("utf8"));
  // This binds publication only; it is not provider or operator admission.
  if (
    manifest?.version !== "provider-test-window/v1" ||
    manifest.noRetry !== true ||
    !manifest.heads ||
    Object.keys(manifest.heads).sort().join(",") !== "candidate,deployed,executor,journal" ||
    Object.values(manifest.heads).some((value) => typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) ||
    !/^[a-f0-9]{64}$/.test(manifest.configuration?.configDigest ?? "") ||
    typeof manifest.paths?.packetDirectory !== "string"
  )
    throw new Error("packet-invalid");
  return manifest;
}

export async function publishCapturePacket(packet, manifestPath, manifestDigest) {
  let temporary;
  let owned;
  try {
    if (!validateCapturePacket(packet) || packet.manifestDigest !== manifestDigest) throw new Error("packet-invalid");
    const payload = Buffer.from(JSON.stringify(packet));
    const safe = parseCapturePacket(payload.toString("utf8"));
    if (safe.manifestDigest !== manifestDigest) throw new Error("packet-invalid");
    const manifest = await publicationContext(manifestPath, manifestDigest);
    if (
      safe.reviewedHead &&
      (safe.reviewedHead !== manifest.heads.candidate ||
        safe.executedHead !== manifest.heads.executor ||
        safe.journalHead !== manifest.heads.journal ||
        safe.deployedHead !== manifest.heads.deployed ||
        safe.configDigest !== manifest.configuration.configDigest)
    )
      throw new Error("packet-invalid");
    const destination = manifest.paths.packetDirectory;
    if (!isAbsolute(destination) || /^[\\/]{2}/.test(destination)) throw new Error("packet-invalid");
    const parent = await realpath(dirname(destination));
    const parentStat = await lstat(dirname(destination));
    const within = relative(REPOSITORY_ROOT, destination);
    if (
      resolve(destination) !== join(parent, relative(dirname(destination), destination)) ||
      !(within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) ||
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
    temporary = `${destination}.partial`;
    await mkdir(temporary, { mode: 0o700 });
    owned = await lstat(temporary);
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
    temporary = undefined;
    return { classification: safe.classification, packetDigest: digest, replayQualified: false };
  } catch {
    throw new Error("packet-invalid");
  } finally {
    if (temporary && owned) {
      try {
        const current = await lstat(temporary);
        if (
          current.isDirectory() &&
          !current.isSymbolicLink() &&
          current.dev === owned.dev &&
          current.ino === owned.ino &&
          (await realpath(dirname(temporary))) === dirname(temporary)
        )
          await rm(temporary, { recursive: true });
      } catch {
        throw new Error("packet-invalid");
      }
    }
  }
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
      parseCapturePacket(Buffer.concat(chunks).toString("utf8")),
      process.argv[2],
      process.argv[3],
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stdout.write('{"classification":"invalid","code":"packet-invalid","replayQualified":false}\n');
    process.exitCode = 2;
  }
}
