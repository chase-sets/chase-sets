# Agent Connector Packaging

Chase Sets publishes connector packaging for the native MCP endpoint from the source-of-truth MCP registry in `infrastructure/platform-runtime/mcp-contracts.ts`.

Generated artifacts:

- [Native MCP registration](./agent-connectors/native-mcp-registration.json): shared endpoint, OAuth, tool, and resource registration metadata.
- [Claude directory manifest](./agent-connectors/claude-directory.manifest.json): Claude remote MCP directory submission metadata.
- [ChatGPT app manifest](./agent-connectors/chatgpt-app.manifest.json): ChatGPT app registration metadata for the native MCP endpoint.
- [Gemini manifest](./agent-connectors/gemini.manifest.json): Gemini connector registration metadata.

Regenerate with:

```powershell
pnpm run generate:agent-connector-packaging
```

The manifests use `https://<marketplace-host>` as a deployment placeholder and include no secrets. OAuth metadata is intentionally truthful to the current runtime: Chase Sets exposes Authorization Code with PKCE for public clients through `/.well-known/oauth-authorization-server`, `/ucp/oauth/authorize`, and `/ucp/oauth/token`; it does not currently mount a dynamic client registration endpoint.
