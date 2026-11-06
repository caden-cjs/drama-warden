# 备份与恢复

本指南面向 Docker Compose 部署。恢复操作使用新的 Compose 项目名创建独立数据卷，验证完成前保留原项目和原数据卷。

## 备份

备份前确认没有处于 `processing` 状态的追更事件或字幕写入任务。停止应用会中断正在进行的供应商 I/O；结果不确定的写入应先按事件和云端目录复核。

```sh
backup_dir="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
docker compose stop drama-warden
docker compose cp --archive drama-warden:/app/data "$backup_dir/data"
docker compose start drama-warden
```

若复制命令失败，先运行 `docker compose start drama-warden` 恢复服务，再检查备份目录。`/app/data` 包含 SQLite 数据库（当 `DB_DRIVER=sqlite`）、媒体文件、夸克/115 CLI 授权和应用运行状态，可能很大且包含凭据。

使用 Compose 内置 MySQL 时，在应用停止期间额外导出数据库：

```sh
docker compose --profile mysql exec -T mysql \
  sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --single-transaction --no-tablespaces --routines --triggers --events --hex-blob -u"$MYSQL_USER" "$MYSQL_DATABASE"' \
  > "$backup_dir/mysql.sql"
```

MySQL dump 只包含配置的应用数据库；MySQL 用户、密码和其他部署参数保存在 `.env`，不会进入备份。外部 MySQL 部署应使用该服务器对应的 `mysqldump` 工具导出同一数据库。

将备份目录加密后存入受控位置。应用数据卷不包含项目目录中的 `.env` 或私有 `config/` 配置；应分别备份它们，并限制 `.env` 的访问权限。不要把备份、环境文件、运行配置、数据库导出或 CLI 授权材料提交到 Git。

## SQLite 恢复到新项目

复制 `.env` 为本机私有的 `.env.recovery`，确认数据库选择仍为 SQLite，并将 `HOST_PORT` 改成未占用端口。若使用自定义配置，再复制并审阅 `config/` 下的私有配置文件；它们默认被 Git、Docker 构建上下文和 npm 包排除。

```sh
docker compose --env-file .env.recovery -p drama-warden-recovery create --build drama-warden
docker compose --env-file .env.recovery -p drama-warden-recovery cp --archive \
  backups/<timestamp>/data/. drama-warden:/app/data
docker compose --env-file .env.recovery -p drama-warden-recovery up -d drama-warden
```

新项目名会创建独立的数据卷。`--archive` 保留非 root 应用用户所需的文件属主和权限。SQLite 数据文件必须位于 `/app/data` 下；若自行将 `SQLITE_PATH` 配置到其他位置，也需另行备份和恢复该路径。

## MySQL 恢复到新项目

复制 `.env` 为私有的 `.env.recovery`，在 `config/config.yaml` 中选择 MySQL，并确认数据库名与 dump 一致、MySQL host 为 `mysql`、恢复项目使用未占用的 `HOST_PORT`。不要复用正在运行项目的 Compose 项目名。

```sh
docker compose --env-file .env.recovery -p drama-warden-recovery --profile mysql up -d mysql
docker compose --env-file .env.recovery -p drama-warden-recovery ps mysql
docker compose --env-file .env.recovery -p drama-warden-recovery exec -T mysql \
  sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE"' \
  < backups/<timestamp>/mysql.sql
docker compose --env-file .env.recovery -p drama-warden-recovery create --build drama-warden
docker compose --env-file .env.recovery -p drama-warden-recovery cp --archive \
  backups/<timestamp>/data/. drama-warden:/app/data
docker compose --env-file .env.recovery -p drama-warden-recovery up -d drama-warden
```

确认 `mysql` 容器健康后再导入。目标数据库必须为空；示例使用新 Compose 项目创建的数据库，不会删除或覆盖原数据库。

## 恢复核对

检查新项目的 `/api/health` 返回 200，再用 `API_ACCESS_TOKEN` 查询节目、追更事件、存储位置和字幕任务。确认目录资产计数与预期相符，并核对需要的夸克/115 CLI 登录状态。恢复结果通过前保留原 Compose 项目、数据卷和备份；不要用 `docker compose down -v` 清理现场。

本指南描述了数据卷复制和 MySQL dump 的恢复路径。2026-11-04 已在隔离 Compose 项目中分别使用 SQLite 和 MySQL 完成最小应用恢复演练：通过 API 创建节目记录，备份停机状态下的 `/app/data`，MySQL 另导出 SQL dump，再恢复到新项目；两种驱动的 `/api/health` 均返回 200，节目记录均能重新查询。

演练使用合成数据库记录，没有包含真实媒体文件或 provider 登录凭据。因此大媒体卷复制性能、真实夸克/115 授权恢复和第三方服务端到端操作仍需在发布前单独验收。
