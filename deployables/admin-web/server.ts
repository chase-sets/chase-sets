// The shared factory loads React, so NODE_ENV must default before it is
// imported; otherwise React binds its development build and react-dom/server
// its production build.
process.env.NODE_ENV ??= "production";
const { startWebServer } = await import("@chase-sets/platform-runtime/web-server");

await startWebServer(new URL(".", import.meta.url));
