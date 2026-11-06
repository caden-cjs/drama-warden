# 贡献指南

欢迎提交问题和改进建议。项目目前处于提炼核心能力的早期阶段，较大的架构改动建议先通过 issue 讨论。

## 开发环境

- Node.js 22.15 或更新版本
- npm
- Docker（仅运行 MySQL 集成测试时需要）
- Docker Compose（按 Compose 方式运行应用时需要）

~~~sh
npm ci
npm run dev
npm run check
npm audit --audit-level=high
npm test
npm run check:licenses
npm run check:plugin-sdk
npm run check:package
npm run check:public-boundary
npm run check:git-history
npm run build
~~~

默认 `npm test` 会跳过需要 MySQL 的集成用例。修改 MySQL repository 或 schema 时，可用临时 MySQL 8.4 容器运行完整套件。容器使用随机本机端口和 tmpfs，不创建持久卷：

~~~sh
docker run --detach --rm --name drama-warden-test-mysql \
  --tmpfs /var/lib/mysql:rw,size=1g \
  --tmpfs /var/run/mysqld:rw,size=64m \
  --env MYSQL_ROOT_PASSWORD=root \
  --env MYSQL_DATABASE=drama_warden_test \
  --env MYSQL_USER=drama_warden \
  --env MYSQL_PASSWORD=drama_warden \
  --publish 127.0.0.1::3306 \
  mysql:8.4

docker port drama-warden-test-mysql 3306/tcp
~~~

把 `docker port` 输出的端口填入 `MYSQL_PORT`，运行集成测试后停止容器：

~~~sh
RUN_MYSQL_INTEGRATION=1 \
MYSQL_HOST=127.0.0.1 \
MYSQL_PORT=32768 \
MYSQL_DATABASE=drama_warden_test \
MYSQL_USER=drama_warden \
MYSQL_PASSWORD=drama_warden \
npm test

docker stop drama-warden-test-mysql
~~~

上例中的 `32768` 仅为格式示例，应替换为实际端口。容器以 `--rm` 启动，停止后会删除。

运行面板开发服务器前，在另一个终端启动后端：

~~~sh
npm start
~~~

Vite 会把 `/api` 请求代理到 `http://127.0.0.1:8080`。当前实现包括 SQLite 数据仓库、节目/元数据/存储位置 API、插件运行时、单分享追更预览/排队、手动事件处理、自动化只读预览、可选 MCP 和 Vue 3 管理面板。夸克和 115 provider 已迁入；API 和插件契约尚未承诺稳定。

## 代码边界

- 新增或修改 provider 前先阅读 [docs/PROVIDERS.md](docs/PROVIDERS.md)，并参考 `examples/plugins/metadata-provider.mjs` 与 `packages/plugin-sdk`；按当前 API v2 契约定义能力、配置和失败语义。该接口仍为 0.x，不承诺稳定。
- 核心模块负责节目状态、缺集判断、事件状态和工作流顺序。
- 插件负责外部服务调用和统一数据转换，不直接改写追更状态。
- `npm run check:architecture` 检查 `backend/core/`、`backend/api/` 和 `backend/db/` 不直接导入 provider 实现；该检查也包含在 `npm run check` 中。
- 插件新增能力应声明在契约中，并说明配置、错误分类、重置和健康检查行为。
- 外部数据进入核心前应校验结构，并限制错误信息和日志中的敏感数据。
- 涉及文件写入、移动或删除时，先定义明确的预览和恢复语义。
- 本地存储插件是文件系统 provider 的参考实现；源目录只读，目标路径限制在配置根目录内。
- 新 provider 应说明文件 ID 稳定性、完整清单语义、路径边界和删除模式。
- 提交前运行 `npm run check`、`npm run check:plugin-sdk`、`npm audit --audit-level=high`、`npm test`、`npm run check:licenses`、`npm run check:package`、`npm run check:public-boundary`、`npm run check:git-history` 和 `npm run build`；MySQL 仓库或 schema 变更还应运行 `RUN_MYSQL_INTEGRATION=1 npm test` 并提供 MySQL 8.4。
- 依赖升级后先核对上游许可证和归属，再运行 `npm run update:license-inventory` 更新锁文件许可证基线并复核差异。

## 提交变更

- 描述用户可见的行为和涉及的模块。
- 不提交密钥、Cookie、Webhook、数据库、运行日志、媒体文件或真实网盘清单。
- 依赖升级需说明原因；不要为了消除安全提示而强制升级不兼容的大版本。
- 有行为变化时，为关键决策和失败恢复路径补充覆盖。
