import type { PublicPolicyRegistryEntry } from "../domain/policy-registry";

export type RenderedPublicPolicyPublicationContract = Readonly<{
  relativePath: string;
  content: string;
}>;

export function renderPublicPolicyPublicationContracts(
  registry?: readonly PublicPolicyRegistryEntry[],
): Promise<readonly RenderedPublicPolicyPublicationContract[]>;
