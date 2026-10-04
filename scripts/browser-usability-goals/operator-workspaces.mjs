export default {
  id: "operator-workspaces",
  routeScope: [
    "^bounded-contexts/(?!catalog/)[^/]+/routes/(admin|access-admin)/",
    "^deployables/admin-web/app/routes/(?!catalog-)",
  ],
  goals: [],
  excludedRoutes: [],
};
