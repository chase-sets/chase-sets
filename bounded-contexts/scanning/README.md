# Scanning

The Scanning bounded context owns the event-sourced scan-session lifecycle and a replayable read model. It stores only bounded opaque `assetRef` metadata and synthetic capture metadata. Image storage, provider adapters, paid dispatch, privacy policy, and Catalog writes belong to their owning contexts.
