import { agentTermsMeta, AgentTermsRouteAdapter } from "../../features/policies/ui/policy-artifact-route-adapter";

export const meta = agentTermsMeta;

export default function AgentTermsRoute() {
  return <AgentTermsRouteAdapter />;
}
