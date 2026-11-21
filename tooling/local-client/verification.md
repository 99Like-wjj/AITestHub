# Source package checks

The build generates the official MCP input schemas from the current platform registration and the two data schemas consumed by the SDK. It uses a fresh compiled source tree. `tools/list` uses the production serializer without invoking tool handlers. The generated contract contains structural data. The platform still checks authorization, business rules and refinements that JSON Schema cannot represent.

`pnpm package` verifies the actual `.tgz` contains the entry module and one current contract with the same SHA-256 as the build output. Verify the package from a clean checkout, install it into an independent project, and run current positive and negative schema cases. Compare the generated tool schemas with an authenticated, matching local Docker `tools/list` when verifying a deployment. Installed-package validation and real tool execution remain separate checks.
