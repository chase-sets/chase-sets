import type { ListResponse } from "@chase-sets/http/responses";
import type { PackagePlan } from "@chase-sets/product-measures";
import { parseJsonResponse, type OrderingClientTransport } from "../../../support/request-support/client";
import type {
  PostagePolicyAdminRecord,
  PostagePolicyCloneRequest,
  PostagePolicyCommandRequest,
  PostagePolicyPreviewRequest,
} from "./contracts";

export function createPostagePolicyClient({ baseUrl, configuredFetch, headers }: OrderingClientTransport) {
  return {
    async listPostagePolicies(query = ""): Promise<ListResponse<PostagePolicyAdminRecord>> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies?${query}`, {
          headers,
        }),
      );
    },
    async getPostagePolicy(policyId: string): Promise<PostagePolicyAdminRecord> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/${encodeURIComponent(policyId)}`, {
          headers,
        }),
      );
    },
    async createPostagePolicy(body: PostagePolicyCommandRequest): Promise<{ id: string; version: number }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async previewPostagePolicy(body: PostagePolicyPreviewRequest): Promise<{ packagePlan: PackagePlan }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/preview`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async revisePostagePolicy(
      policyId: string,
      body: PostagePolicyCommandRequest,
    ): Promise<{ id: string; version: number }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/${encodeURIComponent(policyId)}`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async activatePostagePolicy(policyId: string, activationReason: string): Promise<{ id: string; version: number }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/${encodeURIComponent(policyId)}/activate`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ activationReason }),
        }),
      );
    },
    async clonePostagePolicy(
      policyId: string,
      body: PostagePolicyCloneRequest,
    ): Promise<{ id: string; version: number }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/${encodeURIComponent(policyId)}/clone`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async retirePostagePolicy(policyId: string, retirementReason: string): Promise<{ id: string; version: number }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/postage-policies/${encodeURIComponent(policyId)}/retire`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ retirementReason }),
        }),
      );
    },
  };
}
