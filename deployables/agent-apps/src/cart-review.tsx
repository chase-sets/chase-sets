import { AgentCartReviewView } from "@chase-sets/checkout/web";
import { mountAgentApp } from "./agent-app";

// The M1 handoff binds no onContinue, so the review offers no continue action.
mountAgentApp("Cart Review", ({ theme, state }) => <AgentCartReviewView theme={theme} state={state} />);
