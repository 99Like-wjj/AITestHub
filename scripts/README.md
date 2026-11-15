# Runtime and development tools

The server build explicitly includes migration, administrator bootstrap, operations-worker, control-key preparation, model-checkpoint and current local configuration entry points. Their imported TypeScript helpers are compiled transitively.

`tsconfig.tools.json` is an explicit development-only build for additional local tools. It outputs to the ignored `.local-build/tools` tree. Old live/GUI/probe/incident helpers are retained as local operational history and are excluded from the normal runtime image and source publication.

Shared Skill-rule export reads `AITESTHUB_SKILL_RULE_SOURCES_FILE` and `AITESTHUB_SKILL_RULE_SOURCES_SHA256`. The external `aitesthub.skill-rule-sources.v2` JSON lists the three approved platform Skill versions, archive paths/digests and static rule sections. Existing archive digests and entry paths are verified before exporting; no model, host installation or business operation is performed. Normal builds compile the reviewed generated bundle without reading external archives or sibling checkouts.

The current local MCP metadata exporter reads its expected actor/credential-file location from an external `aitesthub.mcp-export-profile.v1` JSON file, selected by `AITESTHUB_MCP_EXPORT_PROFILE_FILE` and `AITESTHUB_MCP_EXPORT_PROFILE_SHA256`. Credential values are never stored in this metadata profile.
