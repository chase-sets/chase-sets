import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type {
  BcApiModule,
  BcProjectionGroupDeclaration,
  BcProjectionHandlerSet,
} from "@chase-sets/bounded-context-module";
import {
  discoverWorkerContexts,
  loadOwnerContracts,
  readWorkerContractJson,
  type AdmittedContext,
  type OwnerContract,
} from "./worker-graph-contract";

// A synthetic implementation, deliberately independent of its owner expectations.
function createSyntheticModule(manifest: AdmittedContext["manifest"], extraHandler: boolean): BcApiModule {
  const handlers: BcProjectionHandlerSet["handlers"] = extraHandler
    ? {
        "synthetic-worker-extension.fixture.added": async () => {},
        "synthetic-worker-extension.fixture.revised": async () => {},
      }
    : { "synthetic-worker-extension.fixture.added": async () => {} };
  return {
    contextName: "synthetic-worker-extension",
    routePrefix: "/synthetic-worker-extension",
    streamPrefix: "synthetic-worker-extension.",
    schemaSql: "",
    apiMounts: [],
    createServices: () => ({}),
    buildApis: () => [],
    projectionGroups: manifest.projectionGroups,
    projectionHandlerSets: () => [
      {
        projectionName: "synthetic-extension-projection",
        handlers,
        eventTypes: extraHandler
          ? ["synthetic-worker-extension.fixture.added", "synthetic-worker-extension.fixture.revised"]
          : ["synthetic-worker-extension.fixture.added"],
      },
    ],
  };
}

export function syntheticWorkerExtension(
  extraHandler = false,
  mode: "all-profiles" | "landing-only" | "source-only" = "all-profiles",
) {
  const [admitted] = discoverWorkerContexts(fileURLToPath(new URL("./fixtures/worker-extension/", import.meta.url)));
  const [base] = loadOwnerContracts([admitted]);
  const context: AdmittedContext = {
    ...admitted,
    manifest:
      mode === "source-only"
        ? {
            ...admitted.manifest,
            runtimeDeployables: [],
            workerRuntimeProfiles: [],
            sourceRuntimeDeployables: ["platform-worker"],
            sourceRuntimeProfiles: ["landing", "proof", "public"],
            projectionGroups: [],
          }
        : {
            ...admitted.manifest,
            workerRuntimeProfiles: mode === "landing-only" ? ["landing"] : admitted.manifest.workerRuntimeProfiles,
          },
  };
  const contract: OwnerContract =
    mode === "source-only"
      ? { contextName: "synthetic-worker-extension", runners: [], subscriptions: [] }
      : extraHandler
        ? readWorkerContractJson<OwnerContract>(join(admitted.dir, "tests/worker-graph.extended.contract.json"))
        : base;
  const module = createSyntheticModule(admitted.manifest, extraHandler);
  return {
    context,
    contract,
    registration: {
      contextName: context.contextName,
      packageName: context.packageName,
      manifest: context.manifest,
      module: mode === "source-only" ? { ...module, projectionGroups: [], projectionHandlerSets: () => [] } : module,
    },
  };
}

// Synthetic all-profile consumer whose runner exists only when its landing-only
// source is mounted. Implementation declarations never read the owner contract.
export function syntheticConditionalWorkerExtension() {
  const source = syntheticWorkerExtension(false, "landing-only");
  const projectionGroups: readonly BcProjectionGroupDeclaration[] = [
    {
      projectionName: "synthetic-conditional-projection",
      sourceContextNames: ["synthetic-worker-extension"],
      sourceContextMount: "when-all-sources-mounted",
      ownedTables: [],
      sideEffectOnly: true,
    },
  ];
  const context: AdmittedContext = {
    ...source.context,
    contextName: "synthetic-conditional-owner",
    packageName: "@synthetic-worker-fixture/conditional-owner",
    manifest: {
      contextName: "synthetic-conditional-owner",
      runtimeDeployables: ["platform-worker"],
      workerRuntimeProfiles: ["landing", "proof", "public"],
      projectionGroups,
    },
  };
  const module: BcApiModule = {
    contextName: "synthetic-conditional-owner",
    routePrefix: "/synthetic-conditional-owner",
    streamPrefix: "synthetic-conditional-owner.",
    schemaSql: "",
    apiMounts: [],
    createServices: () => ({}),
    buildApis: () => [],
    projectionGroups,
    eventSubscriptions: [
      {
        sourceContextName: "synthetic-worker-extension",
        projectionName: "synthetic-conditional-projection",
        subscriptionVersion: 1,
        projectionHandlerSetNames: [],
        sourceContextMount: "when-all-sources-mounted",
      },
    ],
    buildSubscriptions: () => [
      {
        subscriptionName: "synthetic-conditional-owner.conditional",
        handlerKind: "projection",
        sourceContextName: "synthetic-worker-extension",
        sourceContextMount: "when-all-sources-mounted",
        projectionName: "synthetic-conditional-projection",
        subscriptionVersion: 1,
        handlers: { "synthetic-worker-extension.fixture.added": async () => {} },
        inlineApply: false,
        eventTypes: ["synthetic-worker-extension.fixture.added"],
        streamPrefixes: ["synthetic-worker-extension."],
        order: 0,
      },
    ],
  };
  return [
    source,
    {
      context,
      contract: readWorkerContractJson<OwnerContract>(
        new URL("./fixtures/worker-extension/conditional-owner.contract.json", import.meta.url),
      ),
      registration: {
        contextName: context.contextName,
        packageName: context.packageName,
        manifest: context.manifest,
        module,
      },
    },
  ];
}
