import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerBuild } from "react-router";

export type WebServerTestBuild = ServerBuild & Readonly<{ actionCount: () => number }>;

export type WebServerTestRoot = Readonly<{
  rootDirectory: string;
  rootUrl: URL;
  loadBuild: () => Promise<WebServerTestBuild>;
  remove: () => void;
}>;

/** A client asset larger than the 1 KiB compression threshold. */
export const webServerTestAssetBody = `${"console.log('chase-sets');\n".repeat(160)}`;

export type WebDeployableTestRoot = Readonly<{
  rootDirectory: string;
  remove: () => void;
}>;

// The smallest server build React Router serves: one root UI route (a default
// export, so mutations take the document path and its action-origin check)
// whose action counts its runs, rendered by `renderDocument`. It is plain
// JavaScript so `startWebServer` loads it exactly as it loads a real
// `build/server/index.js`.
const serverBuildModuleSource = (imports: string, renderDocument: string, rootComponent: string) => `${imports}
let actions = 0;
export const actionCount = () => actions;
export const entry = {
  module: {
    default: ${renderDocument},
  },
};
export const routes = {
  root: {
    id: "root",
    path: "",
    module: {
      default: ${rootComponent},
      loader: () => "loaded",
      action: () => {
        actions += 1;
        return "acted";
      },
    },
  },
};
export const assets = {
  entry: { imports: [], module: "/assets/entry.js" },
  routes: {
    root: {
      id: "root",
      path: "",
      module: "/assets/root.js",
      hasAction: true,
      hasLoader: true,
      hasClientAction: false,
      hasClientLoader: false,
      hasClientMiddleware: false,
      hasErrorBoundary: false,
    },
  },
  url: "/assets/manifest.js",
  version: "test",
};
export const publicPath = "/";
export const assetsBuildDirectory = "build/client";
export const future = { v8_passThroughRequests: false, v8_trailingSlashAwareDataRequests: false, v8_middleware: false };
export const ssr = true;
export const isSpaMode = false;
export const prerender = [];
export const routeDiscovery = { mode: "lazy", manifestPath: "/__manifest" };
`;

// An entry that answers with the router status, so tests see routing alone.
const statusServerBuildModuleSource = serverBuildModuleSource(
  "",
  "(_request, status, headers) => new Response(`root ${status}`, { status, headers })",
  "() => null",
);

// An entry that renders the route through React Router's ServerRouter and
// react-dom/server, as a real build's entry.server does.
const reactServerBuildModuleSource = serverBuildModuleSource(
  [
    'import { createElement } from "react";',
    'import { renderToString } from "react-dom/server";',
    'import { ServerRouter } from "react-router";',
  ].join("\n"),
  "(request, status, headers, context) => new Response(renderToString(createElement(ServerRouter, { context, url: request.url })), { status, headers })",
  '() => createElement("p", null, "rendered")',
);

function writeFile(rootDirectory: string, relativePath: string, contents: string) {
  const filePath = path.join(rootDirectory, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

/**
 * A disposable web deployable directory laid out like a built web app:
 * `build/server/index.js`, hashed client assets, an unhashed build file, and
 * a `public/` file.
 */
export function createWebServerTestRoot(): WebServerTestRoot {
  const rootDirectory = mkdtempSync(path.join(tmpdir(), "chase-sets-web-server-"));

  writeFile(rootDirectory, "build/server/index.js", statusServerBuildModuleSource);
  writeFile(rootDirectory, "build/client/assets/entry.js", webServerTestAssetBody);
  writeFile(rootDirectory, "build/client/build-manifest.txt", "build file\n");
  writeFile(rootDirectory, "public/robots.txt", "User-agent: *\n");

  const serverBuildUrl = pathToFileURL(path.join(rootDirectory, "build/server/index.js")).href;
  return {
    rootDirectory,
    rootUrl: pathToFileURL(`${rootDirectory}${path.sep}`),
    loadBuild: () => import(serverBuildUrl),
    remove: () => rmSync(rootDirectory, { recursive: true, force: true }),
  };
}

// What the root (tsx and the shared factory) and the React build import.
const webDeployableRootPackages = ["tsx", "@chase-sets/platform-runtime", "react", "react-dom", "react-router"];

/**
 * A verbatim copy of a web deployable's `server.ts` beside a built app that
 * renders through react-dom/server. Each package it imports links to the real
 * path of the deployable's own copy, so the root, the shared factory and the
 * build resolve the React, react-dom and React Router modules that deployable
 * ships. (pnpm's relative links do not resolve through a linked
 * `node_modules` on Windows, hence one link per package.)
 */
export function createWebDeployableTestRoot(deployableDirectory: string): WebDeployableTestRoot {
  const rootDirectory = mkdtempSync(path.join(tmpdir(), "chase-sets-web-root-"));
  const links: string[] = [];

  writeFile(rootDirectory, "package.json", '{ "type": "module" }\n');
  writeFile(rootDirectory, "server.ts", readFileSync(path.join(deployableDirectory, "server.ts"), "utf8"));
  writeFile(rootDirectory, "build/server/index.js", reactServerBuildModuleSource);
  for (const name of webDeployableRootPackages) {
    const link = path.join(rootDirectory, "node_modules", name);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(realpathSync(path.join(deployableDirectory, "node_modules", name)), link, "junction");
    links.push(link);
  }

  return {
    rootDirectory,
    remove: () => {
      // Unlink first so removal never walks into the deployable's dependencies.
      for (const link of links) unlinkSync(link);
      rmSync(rootDirectory, { recursive: true, force: true });
    },
  };
}
