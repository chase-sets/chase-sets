// Generated from scripts/environment-hosts.json by generate-link-intents.mjs.
import type { LinkEnvironment } from "@chase-sets/bounded-context-module";
import type { WebHostName } from "./web";

// prettier-ignore
export const linkIntentOrigins: Readonly<Record<WebHostName, Readonly<Record<LinkEnvironment, string>>>> = {
  "marketplace-web": {
    "production": "https://marketplace.chasesets.com",
    "staging": "https://marketplace.staging.chasesets.com"
  },
  "admin-web": {
    "production": "https://admin.chasesets.com",
    "staging": "https://admin.staging.chasesets.com"
  },
  "public-web": {
    "production": "https://chasesets.com",
    "staging": "https://staging.chasesets.com"
  }
};
