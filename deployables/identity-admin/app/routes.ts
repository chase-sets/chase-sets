import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.tsx"),
  route("account-select", "routes/account-select.tsx"),
  layout("routes/layout.tsx", [
    index("routes/index.tsx"),
    route("accounts", "routes/accounts.tsx"),
    route("accounts/:id", "routes/accounts-detail.tsx"),
    route("users", "routes/users.tsx"),
    route("users/:id", "routes/users-detail.tsx"),
    route("memberships", "routes/memberships.tsx"),
    route("memberships/:id", "routes/memberships-detail.tsx"),
    route("invitations", "routes/invitations.tsx"),
    route("invitations/:id", "routes/invitations-detail.tsx"),
    route("sessions", "routes/sessions.tsx"),
    route("sessions/:id", "routes/sessions-detail.tsx"),
    route("api-keys", "routes/api-keys.tsx"),
    route("api-keys/:id", "routes/api-keys-detail.tsx"),
  ]),
] satisfies RouteConfig;
