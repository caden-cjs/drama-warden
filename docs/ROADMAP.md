# 路线图

路线图记录开发方向，不代表列出的能力已经实现。

## P1：公开骨架

- 独立仓库、MIT 许可、贡献和安全说明
- 无凭据配置模板、Docker 启动方式和基础 CI
- 服务健康检查与 SQLite 持久层入口

状态：完成。

## P2：追更核心

- 节目、元数据身份、季、集和存储资产仓库
- SQLite 默认驱动与可选 MySQL 驱动
- 版本化的 SQLite/MySQL 应用数据导出与导入
- 元数据提供方回退和 canonical 集数目录
- 缺集判断、追更事件、写入占位和失败恢复
- 逐季缺集计划、未来集分享验证和单次转存上限
- 受 Bearer 令牌保护的节目、元数据身份和追更事件 API
- 单分享追更预览、元数据覆盖核对和季集写入占位
- 显式存储扫描 API；仅完整递归清单标记未见资产缺失
- 单事件处理：复核分享文件 ID、严格核验目录新增文件、整理命名、同步资产、可选刷新索引并终结事件
- 进程中断后的显式事件复核：完成可验证的已保存文件，或确认无输出后保留占位并开放人工重试
- 内置 TVmaze 元数据 provider、可选 TMDB provider、跨 provider 候选搜索和人工身份关联
- 受配置控制的周期资源扫描、候选排队和独立的自动处理开关
- 无需管理面板的 CLI 追更入口，复用受保护 REST API

状态：完成。

SQLite 仓库现使用异步数据库端口，与 `better-sqlite3` 的同步连接对象隔离。TVmaze 默认提供元数据搜索与集数清单；配置 `TMDB_API_KEY` 后启用 TMDB 并排在 TVmaze 前。候选由 Bearer 令牌保护的 `/api/metadata/search` 返回，关联仍由调用方明确确认。MySQL 驱动、独立 schema 和 repository 方言分支已加入。`npm run db:export` 与 `npm run db:import` 导出 schema v4 的 SQLite/MySQL 数据并导入 v3/v4 快照，目标必须为空，并逐表事务导入与核对行数；临时 MySQL 8.4 环境已完成 v3 数据双向实测，未触碰用户数据库。MySQL 8.4 集成测试覆盖迁移、重复启动、资产扫描以及经模拟存储/索引端口运行的追更成功路径、写入前安全重试、写入后不确定状态保护、中断后完成归档和确认无输出后的显式重试；SQLite 默认测试覆盖占位终态原子提交、中断事件的归档恢复、确认无输出后的显式重试、缺失/重复/截断目录清单拒绝恢复，以及同进程操作冲突。SQLite/MySQL 核心路径、显式恢复、自动扫描和无面板 CLI 已完成合成数据验收；真实供应商 CLI、外部字幕 API 和真实媒体/授权恢复属于 P3/P5 外部验收项。资源搜索支持人工预览和可选周期扫描，调度默认关闭且必须配置资源插件；服务端运行设置可在面板持久化，自动处理默认关闭。`npm run cli -- ...` 可从命令行创建节目、搜索并明确关联元数据身份、配置和扫描存储、搜索资源、预览/排队分享并处理事件。`automation scan` 默认只读，事件处理可能写入媒体，须加 `--confirm-write`。单分享处理仍可由 `POST /api/events/:id/process` 手动触发。

中断的 `processing` 和写入结果不确定的 `failed` 事件可通过 `/api/events/:id/recover` 重新核对目录。名字与大小只筛选候选文件，操作人还须确认它们属于本事件；确认无输出时把占位转为 reserved 供人工重试；部分或歧义结果要求人工处理。恢复操作要求单个应用实例。

恢复服务行为测试覆盖 SQLite 和 MySQL，包括完成已保存文件、确认无输出后重试、拒绝不完整目录清单，以及与正在执行的事件冲突。自动扫描回归覆盖手动只读扫描、候选完整性、每位置排队上限、automation 事件过滤与处理、并发跳过及启动/周期调度和独立自动处理开关。HTTP 回归覆盖 `/recover` 的 Bearer 鉴权、事件 ID 校验、输入传递和分享链接脱敏。

## P3：外部提供方

- API v2 插件契约、能力域路由、事件订阅、宿主与 ESM 加载器
- 本地文件系统存储插件，作为不连接网盘的开发适配器
- resource-provider 搜索契约与分享候选不转存预览 API
- 云盘资源、索引、通知和字幕插件
- 可审计的插件调用、配置重置和健康检查

状态：进行中。本地存储与本地资源搜索、通用 resource-provider 契约、夸克和 115 storageContract v2 适配器、存储位置 API、候选预览 API、飞书通知插件、SmartStrm indexer、provider 开发文档、独立 `@drama-warden/plugin-sdk` workspace 和完整 metadata 插件示例已接入。SDK 版本为 0.1.0，尚未发布且 API v2 仍在演进。开源仓库仅内置只读本地资源搜索；其他资源来源由外部 resource-provider 插件提供，核心会传入目标存储类型并复核候选。字幕 provider 契约、OpenSubtitles/Assrt 插件、SQLite/MySQL v2 任务表、持久化 worker、受保护 API 和字幕任务面板已加入；本地存储实现可选 `writeSidecar`，夸克和 115 暂不支持该能力。插件管理页已提供启停、同类排序、自检、reset 和持久调用记录；`plugin_call_log` 保存不含输入/响应内容的调用元数据，启动时和每 100 次调用后裁剪到最新 10,000 条。便携数据库格式升至 v4，仍接受 v3 快照导入并创建空审计表。插件管理数据库只保存启用状态和顺序，插件凭据仍由部署环境管理。非敏感目录、provider 开关、调度参数和可信插件列表可放入 schema 校验过的 `config/config.yaml`，环境变量覆盖 YAML；本地配置文件在 Git/Docker/npm 边界中排除。`npm run check:architecture` 保护核心、API、数据库与 provider 实现之间的依赖边界，并纳入 CI 的 `npm run check`。MySQL 8.4 集成测试覆盖核心追更、插件调用记录保留、资产/写入占位路径和插件设置持久化，追更用例使用模拟存储与索引插件；新增四条 SQLite 集成测试：本地资源/存储流程覆盖候选发现至归档，Quark 插件流程用内存假 CLI 验证仅转存所选 FID、规范改名和状态终结，115 插件流程通过真实 115 storage plugin 与内存假 CLI 验证 path-based 分享选择、转存和归档；CLI 端到端用真实服务与受鉴权 API 跑通本地 metadata 搜索、候选检索、stdin 分享预览/排队、事件处理和归档；同时确认缺少 --confirm-write 时命令拒绝且事件保持 pending，不访问外网或真实网盘。SQLite 与 MySQL 的合成数据 Compose 恢复演练已通过；云盘真实 I/O、真实媒体/授权恢复以及外部字幕 API 的真实调用仍待验收。

2026-11-05 元数据插件自检改为实际请求 TVmaze `/shows/1` 或（配置 TMDB 时）TMDB `/configuration`，失败时仅返回稳定错误码，不返回请求 URL、响应正文或 API key。从当前宿主机调用 TVmaze 自检成功；这只验证 TVmaze API 的基础连通性，不替代真实追更、TMDB 授权、其他 provider I/O 或媒体/凭据恢复验收。

## P4：管理面板与可选 MCP

- 节目、事件、更新记录、字幕任务和设置页面
- 独立 stdio MCP Server 作为可选模块，默认关闭并通过 REST API 操作
- Web 写操作的鉴权和权限边界

MCP stdio bridge 已实现，SDK 和 Zod 为 optional dependencies。Vue 3 面板已覆盖概览、节目创建与元数据关联、存储位置扫描、资源候选和追更预览/排队、事件查看与确认处理、从持久化工作流事件派生的更新记录、字幕任务列表/状态筛选/安全重试/单集排队、插件启停/顺序/自检/reset/调用审计及本地令牌设置。字幕候选按当前资产目录中的唯一视频状态展示；任务写入前会重新核对完整目录，写入结果不确定时显示人工核对提示。运行设置 API 可持久化追更扫描开关、间隔和自动处理开关；自动处理在面板保存时要求确认。数据库连接和插件凭据由部署环境配置；可信插件模块路径可通过私有 YAML 或环境变量加载；API 不提供插件凭据读回或编辑接口。

## P5：发布准备

- 架构、迁移、备份恢复和自定义插件文档
- CI 覆盖核心行为、插件契约和数据库迁移
- 依赖、许可证归属和公开发布内容审查
- 面向公开贡献的问题表单与 PR 提交清单

当前 CI 包含 Node 内置核心/插件/SQLite 测试，并在 MySQL 8.4 服务上执行迁移、repository、资产扫描、追更状态恢复和插件设置持久化集成测试；CI 在安装依赖后直接运行 `npm audit --audit-level=high`，阻断高危和严重漏洞。Dockerfile 固定 Node 与 Python 多架构基础镜像 manifest digest；Dependabot 每周检查 npm 和 GitHub Actions。GitHub 文档指出 Dependabot 不支持 multi-stage Docker builds，因此发布审查仍须核对两个基础镜像 digest 并重新构建。公开边界清单已建立，Git、Docker 和 npm 排除规则补充了凭据目录、证书、媒体和备份文件；应用包设置 `private: true`，不会误发为 npm 包。`@drama-warden/plugin-sdk` 是可单独发布的 MIT workspace，目前 0.1.0 且尚未发布。`npm run check:public-boundary` 扫描当前工作树，`npm run check:git-history` 使用同一规则扫描 HEAD 和所有 refs 可达的已提交快照，CI 会完整获取历史后运行；最新公开边界扫描覆盖工作树 147 个文件。应用 npm 包预览覆盖 133 个文件，SDK 预览覆盖 5 个文件。本地公开历史目前包含 2 个提交；最新 `npm run check:git-history` 已扫描全部可达历史并通过，该检查不覆盖尚未提交的工作区改动。该检查会覆盖所有 refs 可达提交，后续提交仍须重新运行；历史扫描器也曾在隔离 Git fixture 中检出被 `.gitattributes export-ignore` 隐藏及随后删除的 `.env`。当前默认 `npm test` 为 82 项中 79 项通过、3 个 MySQL 集成测试因未启用环境而跳过；2026-11-05 使用无持久卷的隔离 MySQL 8.4 环境运行当前完整套件，82/82 通过。`npm run check`、SDK 语法/类型检查、`npm run check:package`、`npm run check:licenses`（215 个包）、`npm audit --audit-level=high`（0 个漏洞）、公开边界扫描、root `npm run build`、Compose 配置解析、默认 Docker 镜像构建和隔离 smoke 均通过；smoke 确认健康接口、Bearer 鉴权及可选云盘 CLI 未打包。2026-11-04 在隔离 Compose 项目中分别完成 SQLite 与 MySQL 的最小应用恢复演练：新项目恢复后健康检查与合成节目记录核对通过；真实媒体、provider 授权和外部服务操作未覆盖。115 CLI 现由 CPython 3.12 版本与 SHA-256 锁文件固定，amd64/arm64 dry-run 及启用 CLI 的 Docker build 通过；PyPI 最新 `p115cipher==0.0.6` wheel 仍含 GPL-3 文件，最新 `115cli==0.3.4` 仍依赖 0.0.4，因此许可证冲突仍待裁定。Quark CLI issue #14 于 2026-11-05 复核仍 open，固定版 1.0.25 是 GitHub 最新 release 且默认不进入镜像；云盘真实 I/O 和真实授权/媒体恢复验收仍待完成。


2026-11-05 最新复核（开源范围校正后）：准确测试结果、检查覆盖数及构建结果见下方范围校正记录。自动回归仍覆盖 SQLite 默认、MySQL/MCP optional dependencies，以及 HTTP 主服务不导入 MCP SDK。Git 历史扫描已通过当前 2 个本地提交的完整树扫描；Quark 上游遥测问题仍 open，但 Drama Warden 容器已启用固定版 CLI 的内置抑制 guard；115 依赖许可证归属、真实供应商 I/O 及真实媒体/授权恢复仍是发布前待处理项。

### 2026-11-05：P3 资源搜索范围校正与免责声明

- 移除上一轮实验性加入的远程资源搜索专用适配器及其凭据配置。开源仓库不内置依赖特定个人环境的远程资源搜索服务。
- 保留通用 `resource-provider` 契约和只读本地搜索插件；核心继续把目标存储 provider ID 传给资源插件，并在所选存储插件中复核候选。
- README 明确项目仅面向个人学习和家庭自托管，提示非官方网盘接口可能变化、触发账号限制，并要求使用者确认服务规则和内容权利。
- 验证：`npm test` 36 项中 34 项通过、2 个 MySQL 集成测试跳过；`npm run check`、`npm run build`、Compose 配置解析通过；公开边界扫描覆盖 118 个文件，npm 包边界检查覆盖 115 个文件。没有重建 Docker 镜像或访问远程资源服务；上一轮隔离验证镜像已删除。
- 未部署、提交或推送。

### 2026-11-05：P1 公开骨架文档与配置模板复核

- README 新增主要功能列表和 Mermaid 架构图；`.env.example` 为配置项补充用途、默认值或获取方式说明。Compose 现在允许通过 `QUARK_STATE_DIR` 选择持久化夸克状态目录，默认仍位于应用数据卷。
- 验证：`npm test` 默认 36 项中 34 项通过、2 个 MySQL 集成测试跳过；连接隔离 MySQL 8.4 后 36/36 通过。`npm run check`、`npm run build`、`npm run check:licenses`（191 个包）、`npm audit --audit-level=high`（0 个漏洞）、Compose 配置、npm 包边界（115 个文件）、公开边界（118 个文件）和默认 Docker build 通过。隔离容器健康接口返回 200，插件 API 未授权返回 401、授权返回 200；容器和临时镜像已移除。
- 独立仓库尚无提交，完整 Git 历史扫描仍无法执行；未部署、提交或推送。

### 2026-11-05：P1 公开边界规则与回归覆盖

- 扩展工作树扫描器，新增 AWS 临时访问 key、Google API key、live payment key、npm/PyPI token、常见 token/secret 字段及 CGNAT/链路本地 IPv4 检查。
- 新增隔离临时目录用例，验证安全模板不会误报、环境/媒体路径会被拒绝、凭据值不会写入诊断输出，以及新增凭据和网络模式会被识别。
- 验证：隔离 MySQL 8.4 环境下 `npm test` 42/42 通过；`npm run check`、`npm audit --audit-level=high`（0 个漏洞）、`npm run check:licenses`（191 个包）、Compose 配置、npm 包边界（116 个文件）和公开边界（119 个文件）通过。MySQL 容器无持久卷并已移除。
- 未部署、提交或推送。

### 2026-11-05：P1 非敏感 YAML 配置层

- 按开源方案加入 `config/config.example.yaml` 与白名单配置加载器。`npm start` 在导入服务前载入配置；数据库迁移命令也使用同一配置。配置文件只接受明确声明的非敏感字段，未知字段（包括 API key、Cookie、Webhook 和数据库密码）拒绝启动；非空环境变量覆盖 YAML。根目录 `.env` 由 Node 22.9+ 的 `--env-file-if-exists` 选项加载。
- Compose 只读挂载 `config/`；Git、Docker 上下文、npm 包和公开边界检查排除本地配置文件，只保留公开示例。更新 README、数据库、provider、架构和备份恢复说明。新增 YAML 2.9.1（ISC），更新第三方声明和锁文件许可证清单。
- 验证：`npm run check`、`npm run check:package`（应用 120 文件、SDK 5 文件）、`npm run check:licenses`（193 个包）、`npm run check:public-boundary`（128 个文件）、`npm audit --audit-level=high`（0 个漏洞）、前端构建、Compose 配置解析和默认 Docker build 均通过。本轮没有运行测试套件，也没有启动容器、部署或推送。

### 2026-11-05：P2 中断恢复行为与 API 边界验证

- SQLite 行为测试覆盖已保存文件归档、无输出后的显式重试、失败事件的不确定占位复核，以及部分/重复/截断目录和同进程冲突的拒绝路径。新增 REST 测试确认恢复端点鉴权、事件 ID 校验、确认参数传递和分享链接脱敏。
- MySQL 集成用例复用模拟存储与索引插件，验证写入后状态不确定事件可完成，以及确认无输出后保留写入占位并开放显式重试。修复了复核标记字段读取错误，否则即使占位已恢复为 `reserved`，重试仍会被拒绝。
- 验证：默认 `npm test` 57 项中 55 项通过，2 个 MySQL 集成测试跳过；无持久卷隔离 MySQL 8.4 环境下 57/57 全通过。`npm run check`、`npm run check:public-boundary` 和 `git diff --check` 通过。临时 MySQL 容器已移除，未部署、提交或推送。

### 2026-11-05：P3 Quark/115 存储适配器回归

- 新增 Quark 与 115 存储插件测试，覆盖分享文件 ID 脱敏、精确选择转存、失效选择拒绝、存储路径校验和两种不同的 remove 策略。
- 端到端的 115 分享枚举测试发现路径重复：CLI 分享枚举器已返回含文件名的相对路径，存储插件再次拼接文件名。修复规范化逻辑，使完整文件路径保持原样，同时支持只返回目录路径的适配器结果。
- 验证：默认单测 57 项中 55 项通过、2 个 MySQL 测试跳过；隔离 MySQL 8.4 完整测试 57/57 通过。`npm run check`、前端构建、包边界（应用 124 文件、SDK 5 文件）、公开边界（132 文件）通过。未执行真实云盘 I/O，临时 MySQL 容器已移除。

### 2026-11-05：P3 存储清理的完整性保护

- Quark 与 115 的 storage 插件清理入口拒绝截断或标记为 recent 的目录清单，统一报 `INCOMPLETE_STORAGE_LISTING`，避免只按部分结果执行删除或回收。
- Quark 插件清理改为通过存储适配器枚举目录，并逐项调用 Quark 回收能力；行为继续受显式 `recycle` 模式和 `deleteSubdirs`、`deleteDuplicates` 选项控制。
- 云端 `remove`/`clean` 入口拒绝把存储根目录作为目标，和本地存储适配器的根目录保护保持一致。
- 移除仓库内没有调用方的 Quark/115 CLI 组合清理函数，避免绕开 storage 插件入口维护第二套策略。
- 首次修改时未执行真实云盘 I/O 或自动化测试，后续回归结果见下一节。

### 2026-11-05：P3 存储清理回归验证

- 新增 Quark/115 适配器用例，验证截断和 recent 清单在任何删除前被拒绝、存储根目录不能作为清理/删除目标，以及完整清单按 `keepFiles`、`deleteSubdirs` 和 provider 删除策略处理。
- 验证：默认 `npm test` 为 60 项中 58 项通过、2 个 MySQL 测试跳过；无持久卷隔离 MySQL 8.4 环境下 60/60 通过。目标存储测试 6/6 通过。`npm run check`、`npm run build`、`npm run check:package`（应用 124 个文件、SDK 5 个文件）、`npm run check:public-boundary`（132 个文件）、`npm run check:licenses`（193 个包）、`npm audit --audit-level=high`（0 个漏洞）、Compose 配置解析和 `git diff --check` 通过。
- 未执行真实云盘 I/O、Docker 镜像构建、部署、提交或推送。MySQL 测试容器无持久卷，测试后已移除。

### 2026-11-05：P3 插件 SDK 消费者类型检查

- 增加 TypeScript 7.0.2 开发依赖和 `packages/plugin-sdk/type-tests/consumer.mts`；检查会将真实 SDK tarball 展开到隔离消费者目录，再验证 ESM 导入和 TypeScript 声明编译。用例覆盖 metadata、resource、subtitle、storage 和通用插件 helper/lifecycle，并以 `@ts-expect-error` 锁定不支持的删除策略必须被类型拒绝；测试文件不会进入 tarball。
- 扩展 SDK README，说明各 helper、通用 `definePlugin()`、storage v2 删除策略和生命周期；更新第三方声明与许可证基线至 214 个 npm 包。SDK API v2 仍保持未定版、未发布状态。
- 验证：`npm run check:plugin-sdk`、`npm run check`、`npm test`（60 项中 58 项通过、2 个 MySQL 用例跳过）、`npm run check:licenses`（214 个包）、`npm audit --audit-level=high`（0 个漏洞）、`npm run check:package`（应用 124 个文件、SDK 5 个文件）、`npm run check:public-boundary`（133 个文件）、`npm run build`、默认 Docker build 和 `git diff --check` 通过。
- 未重跑 MySQL 集成环境；未部署、提交或推送。验证镜像已删除。

### 2026-11-05：P2/P5 当前工作树全量验证

- 默认 `npm test` 为 60 项中 58 项通过、2 个 MySQL 集成测试跳过；使用随机本机端口、仅 tmpfs 且无持久卷的 MySQL 8.4 临时容器重跑后，60/60 通过。容器已停止并由 `--rm` 移除。
- `npm run check`、`npm run check:plugin-sdk`（真实 tarball ESM 导入及 TypeScript 声明消费者编译）、`npm run build`、`npm run check:package`（应用 126 个文件、SDK 5 个文件）、`npm run check:public-boundary`（135 个文件）、`npm run check:licenses`（214 个包）、`npm audit --audit-level=high`（0 个漏洞）、`npm run check:git-history`（当前 HEAD 2 个提交）和 `docker compose config --quiet` 均通过。
- `npm run check:git-history` 已覆盖当前 2 个本地提交；提交前的公开边界扫描覆盖 135 个工作树文件。默认 Docker 镜像构建和运行检查通过，确认健康接口返回成功、`/api/plugins` 未授权时返回 401、授权时返回成功，且 `115cli`、`p115cipher` 和 Quark CLI 脚本均未打包；随后移除了本轮构建的 `drama-warden:ci` 标签。审查提交只保存在本地，未做真实供应商 I/O、未部署或推送。

### 2026-11-05：P2 追更核心与自动调度验收

- 新增隔离集成测试，以临时 SQLite 数据库和真实 `local-resource`、`local-storage` 插件贯通候选搜索、分享预览与事件排队、本地复制、`Season 01` 归档、规范命名、资产同步，以及事件和写入占位终结。固定 metadata fixture，不访问外部 API；测试确认未选中的视频和说明文件没有被复制。
- 新增 Quark 插件追更集成测试，以临时 SQLite 数据库、真实 Quark storage 插件和内存假 CLI 贯通预览、排队、选定 FID 转存、规范改名、资产同步及事件/写入占位终结；测试只验证插件契约，不访问真实网盘。README 增加无需网盘账号的本地候选搜索到显式追更处理的 CLI 指南。新增 CLI 端到端用例启动真实服务，通过受 Bearer 令牌保护的 API 调用 CLI 完成节目创建、metadata 搜索和关联、本地候选搜索、stdin 分享预览/排队、确认处理与 SQLite 状态核对；缺少 --confirm-write 时拒绝写入且事件保持 pending；禁用 TVmaze 网络 provider，使用固定 fixture。
- 新增 5 项自动扫描/调度测试，验证手动扫描只读、候选完整性、每个存储位置只排队首个候选、只处理 automation 事件、并发扫描跳过，以及调度启动/间隔和独立自动处理开关。
- 验证：默认 `npm test` 为 68 项中 66 项通过、2 个 MySQL 用例因未启用环境而跳过；使用随机本机端口、无持久卷且仅 tmpfs 的 MySQL 8.4 临时容器运行后，68/68 通过。`npm run check`、`npm run check:package`（应用 130 个文件、SDK 5 个文件）、`npm run check:public-boundary`（139 个文件）和 `git diff --check` 通过。
- MySQL 临时容器已停止并自动移除。未进行真实云盘 I/O、部署、提交或推送。真实夸克/115 操作、供应商 CLI 遥测、授权和媒体恢复，以及 `p115cipher` 许可证归属仍是发布前待验收事项。


### 2026-11-05：P5 发布边界复核

- 重新核对 SDK tarball ESM 导入和 TypeScript 消费者编译、214 个 npm 包许可证基线、npm 高危审计（0 项漏洞）、2 个本地 Git 提交的完整历史扫描、前端构建和 Compose 配置解析，均通过。
- 默认 Docker 镜像构建及隔离 smoke 通过：健康接口正常、未授权插件 API 返回 401、Bearer 授权请求成功，且 115 CLI、p115cipher 与 Quark CLI 脚本均未进入镜像。验证镜像标签已移除，smoke 容器由脚本清理。
- 更新后的默认套件为 68 项中 66 项通过、2 个 MySQL 用例跳过；仅 tmpfs 的 MySQL 8.4 全量套件 68/68 通过。当前公开边界扫描覆盖 139 个工作树文件，npm 包边界覆盖应用 130 个文件和 SDK 5 个文件。未部署、提交或推送；供应商 CLI 遥测、115 依赖许可证归属、真实供应商 I/O 和真实媒体/授权恢复仍待发布审查。

### 2026-11-05：P3 插件停用与 reset 生命周期

- 修复停用插件时不执行 `reset()` 的生命周期缺口。停用状态先持久化，宿主立即拒绝新的 capability 调用，等待当前 capability/event 调用结束后再清理；显式 reset 也会暂停新调用并等待当前操作。重新启用仍先执行 `initialize()`。
- reset 失败时插件保持已停用且 API 返回稳定错误码 `PLUGIN_RESET_FAILED`；持久化失败则不改变启用状态、不执行清理。Provider 与 SDK 文档补充了调用顺序和 reset 可重试要求。
- 新增 8 项生命周期测试，覆盖停用/重启启用、调用排空、reset/initialize 串行化、event 回调排空、活跃插件替换保护、设置保存失败及 reset 失败。
- 验证：默认 `npm test` 为 76 项中 74 项通过、2 个 MySQL 集成用例跳过；`npm run check`、`npm run check:plugin-sdk`、`npm run check:package`（应用 131 个文件、SDK 5 个文件）、`npm run check:public-boundary`（140 个文件）、`npm run build` 和 `git diff --check` 通过。未在本轮连接 MySQL 或真实 provider。
- 未部署、提交或推送。

### 2026-11-05：P3 外部插件配置注入

- 插件工厂现在可通过 `context.config` 接收按 `manifest.configSchema` 校验的配置。环境变量命名为 `DRAMA_WARDEN_PLUGIN_<PLUGIN_ID>_<FIELD_KEY>`；支持 kebab ID 与 camelCase 字段转为大写下划线、必填项检查、HTTP(S) URL 检查和未声明字段拒绝。工厂 manifest 若声明 ID/版本/类型则须与插件实例一致，配置字段的 key/type/required 也须一致。
- 扩展 plugin SDK 声明 `PluginConfig`、`PluginFactory` 和工厂上下文类型；Provider/SDK 文档说明私密环境变量设置方式。配置值只传给插件工厂，不保存在数据库、不出现在 manifest/API 或调用审计；无需配置的插件仍可直接导出实例。
- 新增 3 项加载器测试，覆盖正常注入、缺少必填值、非法 URL、未知字段和直接实例导出拒绝配置的路径。
- 验证：默认 `npm test` 为 79 项中 77 项通过、2 个 MySQL 用例跳过；`npm run check`、`npm run check:plugin-sdk`、`npm run check:package`（应用 132 个文件、SDK 5 个文件）、`npm run check:public-boundary`（141 个文件）、`npm run build` 和 `git diff --check` 通过。未连接 MySQL、真实 provider 或外部插件包。
- 未部署、提交或推送。

### 2026-11-05：P3 插件设置 MySQL 持久化验收

- 新增 `backend/tests/mysql-plugin-settings.integration.test.mjs`，使用随机插件 ID 检查停用状态和宿主重建后的恢复；验证重启时禁用插件不会初始化或接受调用，重新启用会先运行 `initialize()` 并写回状态。测试保存并恢复 `application_setting.plugins` 原值，避免污染共用数据库。
- 验证：默认 `npm test` 为 80 项中 77 项通过、3 个 MySQL 集成用例跳过；仅 tmpfs 的隔离 MySQL 8.4 环境下 80/80 通过。`npm run check`、`npm run check:plugin-sdk`、`npm run check:package`（应用 133 个文件、SDK 5 个文件）、`npm run check:public-boundary`（142 个文件）、`npm run build` 和 `git diff --check` 通过。
- 临时 MySQL 容器已停止并自动移除；未执行真实 provider I/O、部署、提交或推送。

### 2026-11-05：P3 115 存储插件追更验收

- 新增 `backend/tests/pan115-followup.integration.test.mjs`，通过真实 115 storage plugin 与内存假 CLI 贯通分享目录遍历、path-based 精确选择、排队、转存、规范改名、资产同步和事件终结；分享中的说明文件未被选择，调用审计不含输入数据。测试不连接真实网盘。
- `npm test` 默认 82 项中 79 项通过、3 个 MySQL 用例跳过；无持久卷的隔离 MySQL 8.4 下 82/82 通过。`npm run check`、`npm run check:plugin-sdk`、`npm run check:package`（应用 134 个文件、SDK 5 个文件）、`npm run check:public-boundary`（143 个文件）、前端构建和 `git diff --check` 通过。
- 临时 MySQL 容器已停止并移除；未执行真实网盘 I/O、部署、提交或推送。

### 2026-11-05：P3 115 授权重试与 P5 许可证复核

- 修复 115 插件授权失败后的重试路径：`reset()` 清除缓存的授权 Promise 和失败标记，停用后重新启用可再次尝试授权。生命周期回归测试验证首次授权失败、reset、重新启用后成功授权，并确认后续调用复用成功状态。
- 复核 PyPI 发行物：`115cli==0.3.4` 仍依赖 `p115cipher==0.0.4`；PyPI 元数据声明 MIT，但归档许可证文件声明 GPL-3。`p115cipher==0.0.6` 的归档仍有相同冲突。项目没有裁定冲突适用哪项声明，默认镜像继续不包含可选 115 CLI。
- 验证：默认 `npm test` 82 项中 79 项通过、3 个 MySQL 集成用例跳过；无持久卷的隔离 MySQL 8.4 下 82/82 通过。`npm run check`、`npm run check:plugin-sdk`、`npm run check:package`（应用 134 个文件、SDK 5 个文件）和公开边界扫描（143 个文件）通过。
- 临时 MySQL 容器已停止并确认移除。本轮没有真实网盘 I/O、部署、提交或推送；供应商 CLI 遥测、许可证归属和真实媒体/授权恢复仍是发布前待处理项。

### 2026-11-05：P3 插件 SDK provider 类型收紧

- SDK 将 `STORAGE_CAPABILITIES` 暴露为与运行时一致的 10 项只读元组；`StorageActionMap` 要求存储插件实现全部共同动作，`writeSidecar` 保持可选；`StorageRemoveModes` 要求至少声明一种删除策略。
- `StorageRemoveInput` 与 `StorageCleanInput` 按删除策略参数化；`defineStoragePlugin()` 根据 `removeModes` 收窄 `remove`/`clean` 的模式，并在返回的 `storageContract` 中保留已声明的模式元组。消费者编译夹具覆盖仅声明 `recycle` 时的有效输入、拒绝 `permanent` 输入及返回类型推导。
- 每项存储动作现在声明自己的输入类型；路径操作、分享选择、目录选项、删除模式和旁路字幕字节均有明确结构，列表和保存结果也使用规范返回类型。资源搜索及字幕搜索/下载有具体输入输出类型，与核心调用和 provider 文档一致。
- TypeScript 消费者夹具逐项实现全部存储动作，编译时读取实际输入字段并返回规范结果。`npm run check:plugin-sdk` 通过 SDK tarball 导入和消费者编译；`npm run check:package` 通过（应用 134 个文件、SDK 5 个文件），`npm run check:public-boundary` 通过（143 个文件），`npm run check` 与 `git diff --check` 通过。
- 未运行测试套件、未部署、提交或推送；SDK API v2 仍未定版，不能据此认为 SDK 已达到发布条件。

### 2026-11-05：P3 SDK tarball 运行时与声明边界

- `check:plugin-sdk` 现在核对 tarball 中 JavaScript 模块和声明文件的完整类型/值导出集合，并与审阅清单比对；外部 TypeScript 消费者夹具导入所有导出并编译主要 plugin/helper 与 storage 模式类型。
- 此检查可发现新增运行时 helper 或常量未进入公开声明、或发行包遗漏值导出的情况；SDK 包仍只包含 manifest、运行时、声明、README 和许可证。
- `npm run check:plugin-sdk`、`npm run check:package` 和 `npm run check:public-boundary` 通过；未运行测试套件、未部署、提交或推送。API v2 仍未定版。

### 2026-11-05：P3 SDK 消费者版本要求

- SDK README 最初注明运行时要求 Node.js `>=22.9`，TypeScript 声明因使用 `const` 类型参数要求 TypeScript `>=5.0`；纯 JavaScript 消费者无需安装 TypeScript。Node 下限后来因 SQLite 原生模块兼容性提高到 `>=22.15`，见下方复测记录。
- 该要求依据 SDK manifest 的 Node engine 和 TypeScript 5.0 发布说明中的 `const` 类型参数语法；CI 现在用锁定的 TypeScript 5.0.4 及当前开发编译器检查隔离消费者夹具。许可证基线更新为 215 个 npm 包，`npm audit --audit-level=high` 为 0 个漏洞。API v2 仍处于演进状态，未发布。

### 2026-11-05：P3 metadata 候选字段类型

- SDK `MetadataCandidate` 补齐内置 TMDB/TVmaze 实际归一化使用的状态、语言、类型、海报/背景路径、评分和外部链接可选字段；每个 provider 只返回自己能提供的字段。
- 外部 TypeScript 消费者夹具读取这些字段，provider 文档列出 metadata 候选和 detail 的规范形状。

### 2026-11-05：P3 SDK 插件上下文类型对齐

- SDK `PluginContext` 补齐运行时实际传递的可选 `showId`、`storageId` 与事件回调 `pluginId`；前两者为应用本地数字标识，不能当作 provider identity。
- 外部 TypeScript 消费者夹具检查这些字段的类型，SDK README 和 provider 指南说明不同生命周期的上下文内容不同。
- `npm run check:plugin-sdk` 在 TypeScript 5.0.4 和 7.0.2 下通过；`check:package`（应用 134 文件、SDK 5 文件）、`check:public-boundary`（143 文件）、`npm run check` 和两边 `git diff --check` 通过。未运行行为测试、部署、提交或推送。

### 2026-11-05：P5 Quark CLI 容器遥测抑制

- 下载并核对第三方声明中的 Quark CLI 归档，SHA-256 与固定值一致。归档内置 `QK_E2E_ACTIVE=1` / `QK_E2E_WPK=0` guard；该版本中这些变量仅用于跳过认证追踪初始化及拦截配置、上报和 flush 调用。Quark 插件子进程继承应用环境。
- Docker 镜像默认设置上述变量；启用 Quark CLI 的构建在原归档哈希和版本检查之外，验证 guard 函数及初始化、上报和 flush 调用点仍在固定脚本中。上游归档本身未修改，默认镜像仍不包含 Quark CLI。
- 可选 Quark 镜像构建成功，CLI 版本和 `--help` 正常；默认镜像构建与隔离 smoke 成功，确认抑制变量存在且 CLI 仍未打包。`npm run check`、`check:package`、`check:public-boundary`、Compose 解析和 `git diff --check` 通过。未运行行为测试、真实账号或云盘 I/O，也未部署、提交或推送。
- 上游遥测 issue 仍 open；抑制只由 Drama Warden 镜像应用，版本或归档哈希变化时必须重新审查 guard。115 许可证归属及真实供应商验收继续待发布审查。

### 2026-11-05：P3/P5 SDK workspace 版本一致性

- 扩展 plugin SDK 包检查：确认应用依赖、lockfile 根依赖和 lockfile 中的 SDK workspace 版本都与 `packages/plugin-sdk/package.json` 完全一致，并从 SDK manifest 读取 workspace 名称，避免版本升级后检查仍打包固定旧名称或依赖旧 workspace 版本。
- Provider SDK 与公开发布文档说明此检查边界。检查仍只验证 workspace/打包关系，不表示 API v2 已稳定或 SDK 已发布。
- 验证：`npm run check:plugin-sdk` 通过（SDK tarball 导入、导出清单及 TypeScript 5.0.4/7.0.2 消费者）；`npm run check:package` 通过（应用 134 个文件、SDK 5 个文件）；`npm run check:public-boundary` 通过（143 个文件）；`git diff --check` 通过。
- 未运行行为测试、未部署、提交或推送。

### 2026-11-05：P5 最低 Node 版本 CI 覆盖

- 初版 CI 新增 Node.js 22.9.0 兼容 job，按根包和 plugin SDK 声明的最低运行版本执行语法/架构检查、SDK tarball 与消费者类型检查、使用临时 SQLite 文件的服务启动/健康检查、默认测试套件及前端构建；现有主 job 继续使用 Node 22 和 MySQL 8.4。最低版本后来提高到 22.15.0，见下方复测记录。
- 初版 job 在新增时尚未本机执行；后续本机兼容复测见“最低 Node 版本实测调整”。GitHub Actions 远端仍未实际运行。
- 未在本轮运行测试、部署、提交或推送。

### 2026-11-05：P5 CI 最小仓库权限

- GitHub Actions 工作流显式将 `GITHUB_TOKEN` 限制为 `contents: read`，并禁用 checkout 持久化凭据；构建、检查和测试 job 不需要写仓库权限。
- 配置通过 YAML 解析和 `git diff --check` 静态检查；未触发远程 GitHub Actions 运行。

### 2026-11-05：P5 CI 边界回归检查

- 新增静态 CI 配置检查并接入 `npm run check`，核对仓库令牌权限、checkout 凭据与完整历史、主要发布检查项，以及根包/SDK 引擎下限与最低 Node job 一致；也确保最低版本 job 使用临时 SQLite 启动应用并检查健康接口。
- 验证：`npm run check` 通过；`npm run check:package` 通过（应用 135 个文件、SDK 5 个文件）；`npm run check:public-boundary` 通过（144 个文件）；`git diff --check` 通过。未运行行为测试，也未触发远程 GitHub Actions。

### 2026-11-05：P5 公开贡献入口

- 新增缺陷报告和功能建议表单，要求用通用场景和合成数据描述问题，并在提交前确认没有凭据、分享链接、个人路径、数据库或媒体数据。
- 新增 PR 清单，提醒贡献者说明变更、文档与迁移影响、适用检查结果，以及插件边界和敏感信息处理。
- 本次仅修改 GitHub 协作模板和路线图，未运行测试、部署、提交或推送。

### 2026-11-05：P3 Provider 异常边界

- 插件宿主现在把 provider 抛出的异常转成无原始消息和 cause 的通用错误，只保留安全格式化的错误码及明确的副作用不确定标记，避免 provider 响应正文或本机路径从 API 异常序列化泄漏。
- capability、`initialize()`、`reset()` 与停用清理路径均使用相同包装；自检和事件回调只返回稳定错误码。
- 外部插件模块导入与 factory 创建失败也不再向启动错误传递原始异常消息或 cause，避免配置密钥被 factory 错误文本带入日志。
- 追更核心只把自身产生的 `DESTINATION_CONFLICT` / `EPISODE_WRITE_CLAIMED` 判为 skipped；provider 即使使用相同错误码也会按失败处理，不能通过代码碰撞决定业务事件状态。
- Provider 文档记录错误消息与事件终态边界。验证：`npm run check`、`npm run check:package`（应用 135 个文件、SDK 5 个文件）、`npm run check:public-boundary`（144 个文件）和 `git diff --check` 通过。
- 未运行行为测试、部署、提交或推送。

### 2026-11-05：P5 当前工作树验证与 npm/Docker 边界

- 新增 GitHub 问题表单和 PR 清单后，发现 `.github/` 默认进入 npm pack 预览；现由 `.npmignore` 与 `.dockerignore` 排除，并让 npm 包检查器拒绝打包 `.github/` 及其他仓库专用路径。公开发布文档已记录该边界。
- 当前默认 `npm test` 为 82 项中 79 项通过、3 个 MySQL 集成用例跳过；使用无持久卷的临时 MySQL 8.4 容器执行 `RUN_MYSQL_INTEGRATION=1 npm test` 后 82/82 通过，容器已停止并移除。
- `npm run check`、`npm run check:plugin-sdk`（TypeScript 5.0.4/7.0.2）、`npm run check:package`（应用 133 个文件、SDK 5 个文件）、`npm run check:public-boundary`（147 个文件）、`npm run check:licenses`（215 个包）、`npm audit --audit-level=high`（0 个漏洞）、`npm run build`、Compose 配置、默认 Docker build 与隔离 smoke、issue form YAML 解析和 `git diff --check` 均通过。
- `npm run check:git-history` 通过当前 2 个已提交快照；它不包含未提交改动。当前工作树由公开边界扫描和实际 npm pack 检查覆盖。未运行真实 provider I/O 或媒体/授权恢复；未部署、提交或推送。

### 2026-11-05：P5 最低 Node 版本实测调整

- 对官方 Node.js 22.9.0 发行包（SHA-256 已核对）执行 better-sqlite3 13.0.3 预编译模块和 Node 22.9 头文件源码构建，两者在打开 `:memory:` 数据库时都会 SIGSEGV；Node 24 上相同源码构建正常。
- Node.js 22.15.0（N-API 10）下，官方预编译模块与源码构建均完成 SQLite 建表、写入和读取。将应用与 plugin SDK 的最低版本统一提高到 `>=22.15`，CI 最低版本 job 锁定 22.15.0。
- Node 22.15.0 下使用 tmpfs MySQL 8.4 执行完整测试套件，82/82 通过、无跳过；临时容器已停止并移除。`npm run check`、`npm run check:plugin-sdk`（TypeScript 5.0.4/7.0.2）和 `npm run build` 通过；临时 SQLite 服务健康接口返回 200。最低 Node CI job 现在也启动 MySQL 8.4 并执行集成用例；贡献指南说明如何启动与清理同类临时数据库。启动 smoke 显式关闭本地存储插件，避免依赖用户目录。
- 使用当前工作树的隔离副本，在 Node 22.15.0 下执行 `npm ci --omit=optional --omit=dev`；安装 4 个运行包、审计 0 个漏洞，确认 `mysql2`、MCP SDK 和 Zod 均未安装。最小依赖服务启动后 SQLite 健康接口返回 200，业务 API 未授权返回 401、Bearer 授权返回 200；临时服务、数据库和副本已清理。
- Context7 查询返回 `fetch failed`；验证依据为官方 Node 发行包、包内源码构建和项目运行结果。未部署、提交或推送。

### 2026-11-05：P3 插件设置生命周期串行化

- 插件设置的 `reset()` 现在与启停、同类排序共用管理队列，避免插件初始化/停用与 reset 并发时出现数据库启用状态和宿主运行状态不一致。
- TVmaze 插件自检当前返回 `ok=true`、`configured=true`；`git diff --check` 通过。未运行测试、部署、提交或推送。

### 2026-11-05：P3 插件错误码契约统一

- 插件运行、加载和自检边界现在统一接受 1–64 位大写 ASCII 字母、数字或下划线作为错误码；缺失或无效值归一为 `PLUGIN_ERROR`，与公开 API 文档一致。
- Provider 指南补充错误码格式。当前工作树的 `npm run check`、`check:architecture`、`check:public-boundary`（147 个文件）、`check:package`（应用 133 个文件、SDK 5 个文件）、`check:plugin-sdk`（TypeScript 5.0.4/7.0.2）、`check:licenses`（215 个包）和 `check:git-history`（2 个已提交快照）均通过；历史扫描不包含未提交文件，后者由工作树扫描覆盖。
- `git diff --check` 通过；未运行行为测试、部署、提交或推送。

### 2026-11-05：P1 外部插件配置入口

- `.env.example` 补充 `DRAMA_WARDEN_PLUGINS` 和插件专属配置变量命名说明，并指向 provider 指南；插件模块也可继续在 `config/config.yaml` 的 `plugins.modules` 配置。
- 验证：`npm run check:public-boundary` 通过（147 个文件），`npm run check:package` 通过（应用 133 个文件、SDK 5 个文件），`git diff --check` 通过；未运行行为测试、部署、提交或推送。

### 2026-11-05：P1 配置模板一致性检查

- 新增 `scripts/check-config-template.mjs` 并接入 `npm run check`：检查 Compose 的 43 个变量都有 `.env.example` 入口或 YAML 配置映射，源码读取的 9 个凭据变量都在 `.env.example` 声明，并确认外部插件凭据前缀有文档说明。`check-ci-config` 也会保护此检查，防止后续静默移除。
- `npm run check`、`npm run check:public-boundary`（148 个文件）、`npm run check:package`（应用 134 个文件、SDK 5 个文件）和 `git diff --check` 通过；未运行行为测试、部署、提交或推送。

### 2026-11-05：P3 外部插件秘密信任边界

- Provider 指南和 SDK README 说明插件配置的环境变量按 schema 注入只提供配置路由，不提供隔离：同进程插件仍可读取 `process.env`、其他已加载模块和应用用户可访问的文件。
- 文档要求将所有已加载插件视为可读取应用凭据的可信代码；需要不同信任边界时应使用独立进程或容器。仅更新文档，未运行测试、部署、提交或推送。

### 2026-11-05：P2/P3/P5 当前工作树复验

- 当前默认 `npm test` 为 82 项中 79 项通过、3 个 MySQL 集成用例跳过；临时、仅 tmpfs 的 MySQL 8.4 环境下 82/82 通过。测试不连接真实网盘或外部字幕服务。
- `npm run check`、SDK tarball 与 TypeScript 5.0.4/7.0.2 消费者检查、`npm run check:package`（应用 134 个文件、SDK 5 个文件）、`npm run check:public-boundary`（148 个文件）、`npm run check:git-history`（2 个已提交快照）、`npm run check:licenses`（215 个包）、`npm audit --audit-level=high`（0 项漏洞）、`npm run build`、Compose 配置解析和 `git diff --check` 均通过。
- 默认 Docker 镜像构建和隔离 smoke 通过：健康接口正常、未授权插件 API 返回 401、Bearer 授权请求成功，且 Quark/115 CLI 未打包。专用镜像标签、smoke 容器与 MySQL 临时容器均已移除。
- 历史扫描只覆盖已提交快照；未提交工作树由公开边界扫描和 npm 包预览检查覆盖。未进行真实 provider I/O、部署、提交或推送；Quark 上游遥测问题、115 依赖许可证归属以及真实媒体/授权恢复仍待发布审查。
