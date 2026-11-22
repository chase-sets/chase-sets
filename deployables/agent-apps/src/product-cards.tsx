import { AgentProductCardsView } from "@chase-sets/discovery/web";
import { mountAgentApp } from "./agent-app";
import { readWidgetOrigins } from "./widget-origins";

const allowedOrigins = readWidgetOrigins(
  document.querySelector<HTMLMetaElement>('meta[name="chase-sets-public-origins"]')?.content,
);

mountAgentApp("Product Cards", (props) => <AgentProductCardsView {...props} allowedOrigins={allowedOrigins} />);
