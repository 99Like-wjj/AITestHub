# AITestHub local client

Tool/Result/Workspace/FileChannel adapters enforce schema/envelope validation, original receipts and same-origin file bytes without automatic side-effect retries.
Tool input validation uses the current official MCP registration from platform source. The build compiles the registration in an isolated directory and collects `tools/list` in process. It projects the two data schemas used by this SDK for file capabilities and knowledge export selection. The generated `dist/contracts/current.json` is ignored in Git and included in the package. Its SHA-256 identifies the exact contract loaded by the SDK.

From a full source checkout, install the pinned workspace dependencies and the independent SDK dependencies. Then package with the commands below. Generation uses the checkout source and installed dependencies. It requires no running Docker, database, account, or API credential. An installed SDK archive includes the generated contract and runs independently of the source checkout.

```sh
pnpm install --frozen-lockfile
pnpm --dir tooling/local-client --ignore-workspace install --frozen-lockfile
pnpm --dir tooling/local-client --ignore-workspace package
```

Host authentication stays outside model-exposed requests. Server authorization remains authoritative.
