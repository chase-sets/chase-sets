export default {
  id: "operator-catalog",
  routeScope: [
    "^bounded-contexts/catalog/routes/",
    "^bounded-contexts/auth/routes/catalog-admin/",
    "^deployables/admin-web/app/routes/catalog-",
  ],
  goals: [],
  excludedRoutes: [],
};
