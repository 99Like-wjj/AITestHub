# GitHub Actions 持续集成与发布

本仓库采用自动检查、自动构建、手动云发布。应用在 GitHub 托管的 Linux 构建机编译；服务器运行已构建的候选镜像。仓库源码、镜像、运行摘要及本地自测确认分别核对。

## 工作流

| 工作流       | 触发                                                         | 行为                                                              |
| ------------ | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| CI           | `feat/`、`fix/`、`docs/`、`chore/` 分支推送及面向 main 的 PR | 锁定版本安装平台和独立 client 依赖，运行 quality:check、构建      |
| Build image  | main 推送或在 main 手动运行                                  | 再次质量检查，构建 Linux amd64 镜像，推私有 GHCR，保存发布摘要    |
| Deploy Cloud | 仅在 main 手动运行                                           | plan 只读预检；deploy 发布已登记本地确认的候选；status 读取原操作 |

源码在 `.github/workflows/`；可重复执行的发布工具在 `deploy/actions/`。第三方 Action 固定到审核的完整提交 SHA。PR 检查没有云端凭据；只有手动发布步骤读取专用部署凭据。main 的分支保护、自动合并和付费套餐分别配置，本轮不以流水线代替它们。

Node、pnpm 沿 package.json 与锁文件的版本，独立 client 按自己的锁文件安装。私有测试、UI 执行、真实模型或目标不在云 CI 中运行；quality:check 和构建通过不代表完整业务回归通过。

## 发布摘要与镜像身份

Build image 的每次运行产生独立制品 `aitesthub-release-运行编号-尝试编号`，其中仅含 `release.json`，保留源码提交、构建运行、不可变镜像引用、Node 和运行文件摘要及 SQL 原字节摘要。重跑不会覆盖原制品；镜像标签也包含提交、运行与尝试编号，实际部署使用 digest。

`imageRef` 是 GHCR 的不可变 manifest/index 引用；`imageId` 是规范 OCI config digest。Docker classic、containerd 和 Desktop 的 inspect.Id 可能不同，因此各端独立解析导出的 config 字节，同时核对 RepoDigest、平台、源码标签、运行容器使用的本机 daemon ID 和运行文件。不得把 manifest、config 或容器 ID 混称为同一摘要。

源码仓库可为公开或私有，镜像包始终保持私有。公开源码构建前须确认包已是私有且链接到本仓库。首次创建包的流程适用于私有源码仓库。推送后再次核对包可见性及来源。镜像不夹带实例配置或部署秘密。公开仓库的发布摘要仅含源码及镜像身份、校验和。云端拉取使用当前 Actions 任务的短期令牌，通过 stdin 传入临时 Docker 配置，拉取后删除本轮配置。

## 本地确认与发布操作

1. 在 Actions 中找到成功的 main Build image 运行编号。用 client 的 download 模式下载该次发布摘要；工具会核对真实仓库、指定工作流、main、成功状态及运行尝试编号。
2. 本地通过具有读取权限的 Docker 凭据拉取摘要中的私有 imageRef，将同一候选镜像部署到本地 Docker。现有平台注册、用例、UI 等必要自测仍沿本地流程完成。
3. 从 `qualify-local.example.json` 建立库外本地配置，核对并固定配置 SHA-256。私钥仅在本机受限文件中保存，公钥事先登记到受信服务器配置。
4. 使用 `qualify-local.mjs --help` 所列命令，传发布摘要、本地配置及摘要、自测证据文件、输出位置，并显式确认本地自测完成。工具检查所有指定应用容器、就绪状态、源码身份及数据库 SQL 校验和，签署该次发布的确认回执。它只保存证据 SHA-256，不上传证据正文，也不声称替代人工或 AI 自测。
5. 用 client 的 qualify 模式和原构建编号登记签名回执。登记不替换应用、不修改数据库。
6. 在 GitHub 的 Actions → Deploy Cloud → Run workflow，选择 main，填写 Build image 运行编号。先用 plan 查看预检，再选 deploy 发布。部署使用已登记的本地签名确认；没有确认的版本会拒绝。

```sh
# 连接配置、配置摘要和回执均由操作者从库外位置提供。
node deploy/actions/client.mjs --action plan --run-id <build-run-id> --connection <external-connection-json> --connection-sha256 <reviewed-sha256>
node deploy/actions/client.mjs --action qualify --run-id <build-run-id> --qualification <signed-receipt-json> --connection <external-connection-json> --connection-sha256 <reviewed-sha256>
node deploy/actions/client.mjs --action status --operation-id <original-operation-uuid> --connection <external-connection-json> --connection-sha256 <reviewed-sha256>
```

连接配置字段为 `schemaVersion: ath.actions-connection.v1`、repository、host、user、sshExecutable、sshKeyFile、knownHostsFile；本地受限管理记录可以另含 signingKeyFile、qualificationPublicKeyFile。真实 host、路径、身份和私钥不写入工作流。发布客户端固定 SSH 主机 Key，不进行自动信任或连接重试。

部署与查询使用独立并发分组，服务器另外持有发布锁。连接中断、超时或结果未知时，读取原 operationId；不要重新运行 deploy 猜测结果。每次云操作的安全回执在 Actions Summary 和独立制品中保留，包含实际阶段、是否发布、是否回退和是否需要恢复。

### 云端回滚镜像保留

每次成功切换应用镜像后，服务器保留当前运行镜像和切换前实际运行的一版应用镜像。再次部署同一镜像时保留原前驱。操作器在本次发布锁内确认就绪、三个应用角色、Ops 运行目录和上一版 Compose 配置，再按受信操作回执轮换更早的回滚镜像。回执和认证发布摘要均能对上的旧 GHCR 本机摘要引用、预拉取标签及本机别名也随之退役。

容器引用包括停用容器，同时检查当前和上一版 Compose、Ops 单元及按需沙箱镜像的引用。存在意外标签、运行依赖或待恢复操作的镜像保留。镜像删除按精确引用执行，不强制删除。轮换结果单列在 `rollbackRetention`。回收失败或结果不明时核对原 operationId，保留待核对的镜像和精确删除意图。已通过就绪的发布不会因此回滚。

此规则仅处理云端本机可确认归属的应用镜像。源码及运行包、产品备份、GitHub Actions JSON 制品和 GHCR 远端保留期各自管理。

## 云端一次性接线

安装审核后的 `server-operator.py` 到源码树外、root 所有的版本化位置，建立 `server-config.example.json` 对应的库外配置并固定其摘要。预建 root 所有的 stateRoot、operations、qualifications 与 operator.lock。实例字段只来自该配置；配置并不授权重建平台、替换控制密钥或重跑迁移。

创建单独的部署 SSH Key，用 forced command 和 restrict 约束为固定的受信 Python 入口及配置摘要。现有管理 Key 不放入 GitHub，签署本地确认的私钥也不放入 GitHub。只将以下专用连接项保存为仓库 Actions Secrets：

- ATH_DEPLOY_HOST
- ATH_DEPLOY_USER
- ATH_DEPLOY_SSH_KEY
- ATH_DEPLOY_KNOWN_HOSTS

受信主机操作器在候选镜像外单独安装，不执行候选内的部署脚本。它只接受 plan、qualify、deploy、status，校验签名与当前平台身份、SQL 校验和和运行基准。应用更新包含产品完整备份及独立认证、维护排空、API/两个 worker 与冻结 Ops 运行根同步、配置与权限不变量回读、就绪检查及拥有范围内的失败回退。

首版只执行数据库结构不变的应用与 Ops 更新；Caddy、基础容器、数据库迁移、数据库恢复及真实目标执行不在这个入口中。相关版本另走对应的明确流程，不能复用旧阶段升级脚本。

## 费用与权限

先使用 GitHub 托管构建机和小型发布摘要；不在正在服务用户的主机安装通用 runner。构建额度、制品存储和 GHCR 定价分别以当前账户账单与官方文档为准，接入不自动升级套餐或开启超额付费。

私有仓库的强制分支检查、原生自动合并及 Environment 审批受套餐限制。手动 workflow_dispatch 是发布触发入口，本地签名确认由主机受信入口验证，两者分别承担不同职责。
