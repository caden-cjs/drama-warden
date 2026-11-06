# 公开发布边界

Drama Warden 是独立维护的自托管应用。公开仓库只包含可复用的应用源码、插件接口、文档和构建配置；不包含个人 NAS 的运行状态或部署材料。

## 纳入范围

- `backend/`、`frontend/`：应用、追更核心、管理面板和插件适配器。
- `docs/`、README、贡献指南、安全说明和 MIT 许可。
- Docker、CI、依赖锁文件及公开配置模板。
- Dockerfile 以多架构镜像 manifest digest 固定 Node/Python 基础镜像；Dependabot 每周检查 npm 和 GitHub Actions 更新。GitHub 文档说明 Dependabot 对 multi-stage Dockerfile 有限制，因此发布审查必须复核两个基础镜像 digest 并重新构建。
- `packages/plugin-sdk/` 是独立的 MIT npm workspace，版本 `0.1.0`，用于外部插件复用 API v2 契约 helpers；API 仍在演进，且该包尚未发布到 npm。应用根包保持 `private: true`。
- [第三方声明](../THIRD-PARTY-NOTICES.md) 和随可选 Quark CLI 镜像构建分发的上游许可证。
- `scripts/check-npm-license-inventory.mjs` 与 `third-party/npm-license-inventory.json`：核对 npm 锁文件中的依赖版本和许可证元数据。
- `scripts/check-package.mjs`：分别检查应用包和 plugin SDK 包的 npm 预览中是否出现敏感文件，并确认各自必需的公开文件存在。
- `scripts/check-plugin-sdk-package.mjs`：检查应用依赖、lockfile 版本及 workspace link 一致；随后从实际 SDK tarball 导入 ESM，核对 JavaScript 值导出和 TypeScript 类型导出与审阅清单完全一致，并在隔离消费者中编译全部公开类型及主要 helper。类型夹具不会进入发行包。
- `scripts/check-public-boundary.mjs`：扫描当前工作树中的敏感文件名、常见凭据格式、内网 URL 和本机路径；CI 会运行此检查。
- `scripts/check-ci-config.mjs`：检查工作流权限、checkout 凭据、完整 Git 历史获取、发布检查项、最低 Node 版本 job，以及配置模板检查仍包含在 `npm run check` 中，避免静态 CI 发布边界被后续工作流修改静默移除。
- `scripts/check-config-template.mjs`：确认 Compose 环境变量都由 `.env.example` 或 YAML 配置映射说明，并检查应用读取的凭据变量在模板中有入口。
- 公开边界回归用例覆盖私有环境/媒体路径、AWS 临时 key、常见 API 凭据、Bearer/JWT、带认证信息的 URL、通用 token/secret 字段、CGNAT 与链路本地地址，并验证检测失败时不会输出凭据值。
- `scripts/check-git-history.mjs`：将每个可达提交导出到临时目录，使用同一公开边界扫描器检查已删除或后续修改过的内容；已提交的构建产物和依赖目录直接拒绝，不因工作树忽略规则而跳过；CI 完整获取历史后运行此检查。
- GitHub CI 的 `GITHUB_TOKEN` 限制为只读仓库内容权限，checkout 步骤不把凭据留在 Git 配置；CI 构建默认 Docker 镜像后，在仅 tmpfs 的临时容器中检查健康接口、Bearer 鉴权，以及 `115cli`、`p115cipher` 与 Quark CLI 脚本均未打包；显式启用 CLI 的构建仍须单独复核对应上游条款和归档校验和。

## 排除范围

- `.env`、`config/` 下除 `config.example.yaml` 外的本地配置、`.npmrc`、`.pypirc`、私钥、证书、认证目录、Cookie、Webhook 和 API 凭据。
- `data/`、SQLite/MySQL 导出、媒体和字幕文件、STRM/播放列表、分享清单、运行日志、压缩归档和备份。
- `.deploy-backups/`、Git 对象、编辑器配置及个人 agent 状态（包括 `.crew/`、`.omc/`、`.superpowers/`、`.run/`）及 CLI 认证目录。HAR 网络抓包和 RAR 归档也不纳入发布。
- 主机目录、内网地址和具体部署环境配置。

`.gitignore` 控制日常工作区状态，`.dockerignore` 限制镜像构建上下文，`.npmignore` 控制 npm 包内容。因为仓库有 `.npmignore`，npm pack 不会使用 `.gitignore` 的规则；目前它会排除 `.github/` 和 `config/` 下的本地配置并保留 `config/config.example.yaml`，`npm run check:package` 还会检查实际包预览。三者也排除常见媒体、字幕、播放列表和压缩归档后缀，即使文件被放在 `data/` 之外。`npm run check:public-boundary` 检查当前工作树中的敏感文件和已知凭据格式。`npm run check:licenses` 对比锁文件中的包版本及许可证元数据与已审核基线；依赖升级后先复核上游声明，再用 `npm run update:license-inventory` 更新基线。各项检查用途不同，新增运行数据或凭据格式时应同步更新规则和检查器。它们不能替代对完整 Git 历史的人工审阅。应用 npm 包 `private: true`，只供边界检查，不发布；`@drama-warden/plugin-sdk` 由独立 workspace manifest 控制，准备发布时须单独复核版本、打包文件与 API 稳定性。

## 对外发布前检查

1. 检查 Git 当前变更和所有待提交文件；运行 `npm run check:git-history` 扫描完整提交历史，并人工确认没有密钥、Cookie、Webhook、个人路径、真实媒体清单或数据库。
2. 执行 `npm audit --audit-level=high`、`npm run check:licenses`、`npm run check:plugin-sdk`、`npm run check:package`、`npm run check:public-boundary` 并检查 Docker build context；这些检查通过仍不能替代对 Git 历史和本地部署文件的人工审阅。
3. 执行 CI，包括核心行为测试、插件契约、SQLite/MySQL 迁移集成测试、前端构建和镜像构建。
4. 执行 npm 依赖安全审计；核对直接与镜像内安装的第三方 CLI、npm/pip 依赖的许可证和归属要求，并确认服务条款及账号风险说明仍准确。
5. 按 [备份与恢复指南](BACKUP-RESTORE.md) 完成 SQLite 与 MySQL 的隔离恢复演练；若要宣称可恢复媒体和 provider 授权，还需用代表性媒体数据及可轮换的测试账号验证这两类状态。

本清单记录项目边界和发布前要求，不表示项目已经公开发布，也不表示上述检查都已完成。

发布 plugin SDK 前，先复核 `packages/plugin-sdk/README.md`、版本、API v2 稳定性和包内容。`npm run check:package` 只检查 npm 包预览，不会发布该包。

默认镜像不包含 Quark 或 115 CLI。Quark CLI 1.0.25 的上游遥测问题仍未关闭；Drama Warden 镜像为这个固定归档启用其内置抑制 guard，Quark 可选构建会在校验归档 SHA-256 后验证 guard 的初始化、上报和 flush 入口，并继续检查 CLI 版本与 help 命令。该抑制只由 Drama Warden 镜像应用；在镜像外直接运行上游脚本时须自行设置相同环境变量。更换归档版本或校验和时，应重新审阅遥测代码和 guard。115 CLI 的 `p115cipher==0.0.4` 元数据与随包许可证文本仍冲突。发布前应重新检查两项上游状态、镜像构建参数、归档校验和与[第三方声明](../THIRD-PARTY-NOTICES.md)。
