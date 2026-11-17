# Conversation files and read-only previews

Files are aggregated from the current user's authorized conversations. Project membership does not grant access to another user's private conversations. List, tree, associations, history, content and preview recheck current conversation and resource permissions. No-store responses and identity-aware client caches prevent reuse after identity changes.

Accepted user message attachments are registered as original workspace entries in the message transaction, reusing their resource bytes. Draft uploads are not accepted attachments. Originals cannot be overwritten, renamed, removed or restored by workspace commands; existing privacy deletion remains authoritative. AI calculation and Office outputs create independent artifacts with actual input snapshots, author, task, message and base revision. Updating an artifact adds a version. Restoring an old version also appends a version. Legacy entries retain their existing history unless reliable provenance proves their classification.

## Preview components

Text, code, Markdown, structured files and ZIP directories are rendered locally from authenticated bytes. HTML and SVG are isolated from scripts, external requests and the platform session. PDF.js and its worker are bundled locally. Media endpoints support bounded byte ranges; previews do not invoke models or execute uploaded code.

`FileCenterService` authorizes the source before and after conversion, verifies its hash and bounds concurrent conversions and the expiring cache. `SandboxFilePreviewRenderer` runs a fixed program through the existing sandbox port. It receives file bytes and validated sheet pagination, without model prompts, platform credentials or host paths.

The preview execution image is built with `deploy/local/Dockerfile.preview` from the exact, independently verified Office guest image and an explicit `LIBREOFFICE_VERSION`. Deploy the resulting immutable image through the sandbox broker's existing execution-image binding. It adds LibreOffice document conversion, not a browser service. The API does not receive Docker privileges. Preserve the sandbox's nonroot, readonly, networkless execution and resource limits.

DOCX, PPTX, ODT and ODP are converted to actual PDFs. XLSX, ODS, CSV and TSV are read as paginated worksheet content. Formulas are never evaluated: existing cache values and missing caches are identified. Office layout/font conversion limitations are reported to the user.

Current conversion bounds are 12 MiB input, 4 MiB per sandbox output, 100 seconds per request, 100 worksheets, up to 500 rows per page and the first 200 columns per row. Expanded ZIP structure and XML are also bounded. Files above a supported boundary remain available for authorized download; previews never silently claim to represent omitted content. Images, media and plain text have separate client rendering limits.

## Retired office browser

The platform office-browser operation capability is removed. Public search and static HTTP page reading remain separate capabilities. General HTML/file previews, model image transport and user-local AI/Ego test execution remain available. Old migrations retain their bytes; the forward removal migration clears browser runtime data and derived contexts before dropping its dedicated database objects. A retired tool name in immutable history or a cleanup migration is not an executable capability.
