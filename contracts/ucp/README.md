# UCP Contract

`@chase-sets/ucp` owns Universal Commerce Protocol boundary contracts for Chase Sets.

It contains:

- UCP version and capability constants.
- Business profile construction for REST and MCP transports.
- Transport-neutral UCP envelope and message types.
- UCP MCP tool metadata used by the standards-facing `/ucp/mcp` surface.

This package does not own commerce behavior. Discovery, Checkout, Ordering, Payments, Auth, and Identity remain responsible for the domain rules and handlers behind UCP operations.
