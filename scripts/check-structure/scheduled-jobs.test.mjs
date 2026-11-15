import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { afterEach, describe, expect, it } from "vitest";
import { checkScheduledJobBindings, findAnonymousServiceAssertions, validateScheduledJobs } from "./scheduled-jobs.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture({
  factory = "export function createJobs():readonly WorkerRunner[]{return []}",
  binding = "createJobs",
  server = 'export {createJobs} from "./jobs";',
  owner = false,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "scheduled-jobs-"));
  roots.push(root);
  const write = (file, content) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write(
    "contracts/bounded-context-module/index.ts",
    'export type WorkerRunner={name:string;kind:"job";runOnce:()=>Promise<{processed:number}>};',
  );
  write(
    "bounded-contexts/example/jobs.ts",
    `import type {WorkerRunner} from "../../contracts/bounded-context-module/index";${factory}`,
  );
  write(
    "bounded-contexts/other/jobs.ts",
    'import type {WorkerRunner} from "../../contracts/bounded-context-module/index";export function createJobs():readonly WorkerRunner[]{return []}',
  );
  write("bounded-contexts/example/server.ts", owner ? 'export {createJobs} from "../other/jobs";' : server);
  write(
    "bounded-contexts/example/index.ts",
    `import {createJobs} from "${owner ? "../other/jobs" : "./jobs"}";export const module={workerJobFactories:{${binding}}};`,
  );
  const program = ts.createProgram({
    rootNames: [
      path.join(root, "bounded-contexts/example/index.ts"),
      path.join(root, "bounded-contexts/example/server.ts"),
    ],
    options: {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  });
  return checkScheduledJobBindings({
    program,
    rootDir: root,
    contexts: [
      {
        contextName: "example",
        root: "bounded-contexts/example",
        scheduledJobs: [{ id: "example.job", runnerExport: "createJobs" }],
      },
    ],
  });
}
describe("scheduled job module/server binding", () => {
  it("validates the actual registered context factories", () => expect(validateScheduledJobs().violations).toEqual([]));
  it("accepts the identical owned canonical factory", () => expect(fixture()).toEqual([]));
  it("rejects missing factory even with plausible name/comment", () =>
    expect(
      fixture({ server: "// createJobs is a WorkerRunner factory\nexport const plausibleCreateJobs = true;" }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("example/example.job") })]),
    ));
  it("rejects a factory exported but not registered on entry.module", () =>
    expect(fixture({ binding: "notTheFactory: createJobs" })).not.toEqual([]));
  it("rejects a different binding with the same export name", () =>
    expect(fixture({ binding: "createJobs:()=>[]" })).not.toEqual([]));
  it("rejects a wrong-owner factory", () => expect(fixture({ owner: true })[0].message).toContain("another context"));
  it("rejects a copied or mistyped signature", () => {
    expect(fixture({ factory: "export function createJobs():readonly {name:string}[]{return []}" })).not.toEqual([]);
    expect(fixture({ factory: "export function createJobs():readonly WorkerRunner[]{return [42]}" })).not.toEqual([]);
    expect(
      fixture({ factory: "export async function createJobs():Promise<readonly WorkerRunner[]>{return []}" }),
    ).not.toEqual([]);
    expect(
      fixture({ factory: "export function createJobs():{runners:readonly WorkerRunner[]}{return {runners:[]}}" }),
    ).not.toEqual([]);
  });
});
describe("worker service assertion inventory", () => {
  it("rejects multiline, mounted, aliased and helper-input shapes", () => {
    for (const source of [
      "const value=runtime.services.discovery as\n | {googleShoppingSync:unknown}\n | undefined;",
      "const mounted=runtime.mountedContexts.find(x=>true);const value=mounted?.services as {dispatch:unknown};",
      "const {discovery:alias}=runtime.services;const value=alias as {sync:unknown};",
      "function helper(services:Readonly<Record<string,unknown>>){return services.discovery as {sync:unknown}}",
      "function helper(bag){return bag.discovery as {sync:unknown}}helper(runtime.services);",
    ])
      expect(findAnonymousServiceAssertions(source)).toHaveLength(1);
  });
  it("accepts imported real service contracts and unrelated shapes", () => {
    expect(
      findAnonymousServiceAssertions(
        "const x=runtime.services.discovery as DiscoveryServices|undefined; const y=pool as {end:()=>void};",
      ),
    ).toEqual([]);
  });
});
