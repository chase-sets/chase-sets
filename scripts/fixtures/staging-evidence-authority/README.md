# Staging evidence authority fixtures

The provider-mode and sign-in files are labeled synthetic controls. The
provider-mode `observedAt` equals the AC-06 clock `2026-10-19T13:00:00Z`, just
after the captured Deploy Staging job completed. Readiness
and deploy-generation tests use the captured sibling fixtures directly so this
slice cannot silently drift from the executable observers' captured shapes.
No fixture contains a credential or a real session token.
