# Portable local Docker setup

Use exact pinned package/image versions. Environment settings and secrets stay in the configured private runtime root.
Setup scripts are for an explicitly authorized new installation. Existing instances retain their volumes/identities and require a backup plus a version-specific upgrade plan.
Dockerfile builds Web/API/workers; Compose reads environment and credential file paths instead of committed values.
Do not replay unknown tasks, rebuild an existing control anchor or use test fixtures to bootstrap production.
