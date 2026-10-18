import { startWebServer } from "@chase-sets/platform-runtime/web-server";

await startWebServer(new URL(".", import.meta.url));
