import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { repoRoot } from "./repo.mjs";

const checkoutRoot = path.resolve(repoRoot);
const isWindows = process.platform === "win32";

function isInsideCheckout(target) {
  if (typeof target === "number") return undefined;
  const absolute = path.resolve(target instanceof URL ? fileURLToPath(target) : String(target));
  const root = isWindows ? checkoutRoot.toLowerCase() : checkoutRoot;
  const candidate = isWindows ? absolute.toLowerCase() : absolute;
  return candidate === root || candidate.startsWith(`${root}${path.sep}`) ? absolute : undefined;
}

function trackedPath(target) {
  const absolute = isInsideCheckout(target);
  if (!absolute) return undefined;
  const relative = path.relative(checkoutRoot, absolute).split(path.sep).join("/");
  const listed = execFileSync("git", ["ls-files", "-z", "--", relative || "."], {
    cwd: checkoutRoot,
    encoding: "utf8",
  });
  return listed.length > 0 ? relative || "." : undefined;
}

function rejectIfTracked(target) {
  const relative = trackedPath(target);
  if (relative) throw new Error(`tracked-checkout-write-guard: refusing write to tracked path '${relative}'`);
}

function wrapPathMethod(object, name, targetIndex = 0) {
  const original = object[name];
  if (!original) return;
  object[name] = function guarded(...args) {
    rejectIfTracked(args[targetIndex]);
    return original.apply(this, args);
  };
}

function wrapRename(object, name) {
  const original = object[name];
  if (!original) return;
  object[name] = function guarded(...args) {
    rejectIfTracked(args[1]);
    return original.apply(this, args);
  };
}

function wrapOpen(object, name) {
  const original = object[name];
  object[name] = function guarded(file, flags, ...rest) {
    const mode = flags == null || typeof flags === "function" ? "r" : flags;
    if (mode !== "r" && mode !== fs.constants.O_RDONLY) {
      rejectIfTracked(file);
    }
    return original.call(this, file, flags, ...rest);
  };
}

let installed = false;
function installTrackedCheckoutWriteGuard() {
  if (installed) return;
  installed = true;
  for (const name of [
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "truncate",
    "truncateSync",
    "rm",
    "rmSync",
    "unlink",
    "unlinkSync",
  ]) {
    wrapPathMethod(fs, name);
    wrapPathMethod(fsp, name);
  }
  for (const name of ["rename", "renameSync", "copyFile", "copyFileSync"]) {
    wrapRename(fs, name);
    wrapRename(fsp, name);
  }
  wrapOpen(fs, "open");
  wrapOpen(fs, "openSync");
  wrapOpen(fsp, "open");
  const originalStream = fs.createWriteStream;
  fs.createWriteStream = function guarded(file, options, ...rest) {
    const flags = typeof options === "string" ? options : (options?.flags ?? "w");
    if (flags !== "r") rejectIfTracked(file);
    return originalStream.call(this, file, options, ...rest);
  };
  syncBuiltinESMExports();
}

installTrackedCheckoutWriteGuard();
