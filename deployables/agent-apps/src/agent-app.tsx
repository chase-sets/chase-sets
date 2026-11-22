import { App } from "@modelcontextprotocol/ext-apps";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@chase-sets/design-system/styles.css";

export type AgentAppViewProps = Readonly<{
  theme: NonNullable<ReturnType<App["getHostContext"]>>["theme"];
  state: { kind: "loading" } | { kind: "result"; result: unknown };
  openLink: (url: string) => Promise<void>;
}>;

/** Connects one widget view to the MCP Apps host: tool lifecycle, host theme, and `ui/open-link`. */
export function mountAgentApp(name: string, view: (props: AgentAppViewProps) => ReactNode) {
  const mount = document.getElementById("app");
  if (!mount) throw new Error(`${name} mount is missing.`);
  const root = createRoot(mount);
  const app = new App({ name: `Chase Sets ${name}`, version: "2.0.0" });

  let theme: AgentAppViewProps["theme"];
  let state: AgentAppViewProps["state"] = { kind: "loading" };
  const openLink: AgentAppViewProps["openLink"] = async (url) => {
    const result = await app.openLink({ url });
    if (result.isError) throw new Error("The host declined to open the link.");
  };

  function render() {
    root.render(view({ theme, state, openLink }));
  }

  app.ontoolresult = (result) => {
    state = { kind: "result", result };
    render();
  };
  app.ontoolinput = () => {
    state = { kind: "loading" };
    render();
  };
  app.ontoolcancelled = () => {
    state = { kind: "result", result: undefined };
    render();
  };
  app.onhostcontextchanged = () => {
    theme = app.getHostContext()?.theme;
    render();
  };

  render();
  void app.connect().then(
    () => {
      theme = app.getHostContext()?.theme;
      render();
    },
    () => {
      state = { kind: "result", result: undefined };
      render();
    },
  );
}
