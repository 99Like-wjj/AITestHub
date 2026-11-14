# AITestHub

Test-management platform with Web, HTTP/MCP services, local UI-test integration, API execution and a reusable client.

## Layout
- apps/: Web, API and workers.
- packages/: contracts, application services, persistence, storage and model adapters.
- tooling/local-client/: reusable MCP client and reviewed schemas.
- deploy/local/: portable Docker setup.
- Related repositories: AITestHub-CaseDesign-Skill, AITestHub-Knowledge-Skill and AITestHub-EgoTest-Skill.

## Development
Use the exact Node/pnpm versions in package.json and committed lockfiles.

    pnpm install --frozen-lockfile
    pnpm typecheck
    pnpm build
    pnpm format:check

Independent client:

    cd tooling/local-client
    pnpm --ignore-workspace install --frozen-lockfile
    pnpm --ignore-workspace build

Test suites, captured evidence and test-only runners stay in the private local workspace and are omitted from this repository.
Supply independent private environment and secret files for deployment. Existing-instance maintenance requires a backup and version-specific upgrade/checkpoint plan.
UI execution stays in the user's local AI/Ego host; the server does not wake a remote browser.

See SECURITY.md and SOURCE_PUBLICATION.md.

## Deployment profiles

Instance identity and archive paths are external reviewed JSON configurations. See [configuration boundary](deploy/personal-cloud/CONFIGURATION.md) and [tool categories](scripts/README.md). No real profile or credential is committed. Source maintenance does not update an already deployed image.
