import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// The smallest server build React Router serves: one root UI route (a default
// export, so mutations take the document path and its action-origin check)
// whose action counts its runs, rendered by an entry that answers with the
// router status. It is plain JavaScript so `startWebServer` loads it exactly
// as it loads a real `build/server/index.js`.
const serverBuildModuleSource = `let actions = 0;
export const actionCount = () => actions;
export const entry = {
  module: {
    default: (_request, status, headers) => new Response(\`root \${status}\`, { status, headers }),
  },
};
export const routes = {
  root: {
    id: "root",
    path: "",
    module: {
      default: () => null,
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

/**
 * A disposable web deployable directory laid out like a built web app:
 * `build/server/index.js`, hashed client assets, an unhashed build file, and
 * a `public/` file.
 */
export function createWebServerTestRoot(): WebServerTestRoot {
  const rootDirectory = mkdtempSync(path.join(tmpdir(), "chase-sets-web-server-"));
  const write = (relativePath: string, contents: string) => {
    const filePath = path.join(rootDirectory, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  };

  write("build/server/index.js", serverBuildModuleSource);
  write("build/client/assets/entry.js", webServerTestAssetBody);
  write("build/client/build-manifest.txt", "build file\n");
  write("public/robots.txt", "User-agent: *\n");

  const serverBuildUrl = pathToFileURL(path.join(rootDirectory, "build/server/index.js")).href;
  return {
    rootDirectory,
    rootUrl: pathToFileURL(`${rootDirectory}${path.sep}`),
    loadBuild: () => import(serverBuildUrl),
    remove: () => rmSync(rootDirectory, { recursive: true, force: true }),
  };
}
