import type {
  RealtimeTopicManifest,
  RealtimeTopicPolicyManifest,
} from "@chase-sets/platform-runtime/realtime";
import { createRealtimeRouteSubscriptionPreset } from "@chase-sets/platform-runtime/realtime-web";

export const catalogAdminRealtimeSurfaces = [
  "blueprints",
  "catalog-items",
  "categories",
  "components",
  "dimensions",
  "fields",
  "reference-records",
  "reference-types",
  "source-observations",
] as const;

export type CatalogAdminRealtimeSurface = typeof catalogAdminRealtimeSurfaces[number];

const catalogAdminRealtimeSurfaceSet = new Set<string>(catalogAdminRealtimeSurfaces);

export const catalogRealtimeTopics = {
  adminSurface: (surface: CatalogAdminRealtimeSurface) => `catalog:admin:${surface}`,
} as const;

export const catalogRealtimeRouteTopics = {
  blueprints: () => createCatalogAdminPreset("blueprints"),
  catalogItems: () => createCatalogAdminPreset("catalog-items"),
  categories: () => createCatalogAdminPreset("categories"),
  components: () => createCatalogAdminPreset("components"),
  dimensions: () => createCatalogAdminPreset("dimensions"),
  fields: () => createCatalogAdminPreset("fields"),
  referenceRecords: () => createCatalogAdminPreset("reference-records"),
  referenceTypes: () => createCatalogAdminPreset("reference-types"),
  sourceObservations: () => createCatalogAdminPreset("source-observations"),
} as const;

export const catalogRealtimeManifest = {
  contextName: "catalog",
  topics: catalogRealtimeTopics,
  topicPrefixes: ["catalog:admin:"],
} satisfies RealtimeTopicManifest<typeof catalogRealtimeTopics>;

export const catalogRealtimeTopicPolicyManifest = {
  contextName: "catalog",
  policies: [
    {
      name: "catalog-admin-surface",
      match: (topic) => {
        const segments = topic.split(":");
        if (
          segments.length === 3 &&
          segments[0] === "catalog" &&
          segments[1] === "admin" &&
          catalogAdminRealtimeSurfaceSet.has(segments[2] ?? "")
        ) {
          return { family: "admin" };
        }

        return null;
      },
      authorize: (_match, actor) => actor?.permissions.includes("catalog.view") ?? false,
    },
  ],
} satisfies RealtimeTopicPolicyManifest;

export const catalogRealtimeRegistration = catalogRealtimeManifest;

function createCatalogAdminPreset(surface: CatalogAdminRealtimeSurface) {
  return createRealtimeRouteSubscriptionPreset(`catalog.admin.${surface}`, [
    catalogRealtimeTopics.adminSurface(surface),
  ]);
}
