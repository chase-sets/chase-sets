import { agentTermsMeta, AgentTermsRouteAdapter } from "../policy-artifact-route-adapter";

export const meta = agentTermsMeta;

export default function AgentTermsRoute() {
  return <AgentTermsRouteAdapter />;
}
