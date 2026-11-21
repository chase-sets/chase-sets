import { App } from "@modelcontextprotocol/ext-apps";
import { createRoot } from "react-dom/client";
import type { ComponentProps } from "react";
import { AgentProductCardsView } from "@chase-sets/discovery/web";
import "@chase-sets/design-system/styles.css";
import { readWidgetOrigins } from "./widget-origins";

type ViewProps = ComponentProps<typeof AgentProductCardsView>;

const mount = document.getElementById("app");
if (!mount) throw new Error("Product cards mount is missing.");
const root = createRoot(mount);
const app = new App({ name: "Chase Sets Product Cards", version: "2.0.0" });
const allowedOrigins = readWidgetOrigins(
  document.querySelector<HTMLMetaElement>('meta[name="chase-sets-public-origins"]')?.content,
);

let theme: ViewProps["theme"];
let state: ViewProps["state"] = { kind: "loading" };
const openLink: ViewProps["openLink"] = async (url) => {
  const result = await app.openLink({ url });
  if (result.isError) throw new Error("The host declined to open the product page.");
};

function render() {
  root.render(<AgentProductCardsView {...{ theme, state, allowedOrigins, openLink }} />);
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
