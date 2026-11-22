import { AgentCheckoutHandoffView } from "@chase-sets/checkout/web";
import { mountAgentApp } from "./agent-app";

mountAgentApp("Checkout Handoff", (props) => <AgentCheckoutHandoffView {...props} />);
