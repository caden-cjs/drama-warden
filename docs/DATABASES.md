# Database setup

SQLite is the default database and needs no server. MySQL is an optional backend with a separate schema and SQL dialect. Both drivers implement the same asynchronous database port. The `mysql2` package is an optional dependency and is dynamically loaded only when `DB_DRIVER=mysql` is selected; a SQLite installation does not import the MySQL driver. Non-secret driver and connection settings come from `config/config.yaml`; non-empty process environment values override the YAML file. Database passwords remain in `.env` or the process environment. The app loads `config/config.yaml` when present and otherwise uses `config/config.example.yaml`.

## SQLite

Set `database.driver: sqlite` in `config/config.yaml`. The example uses `./data/drama-warden.sqlite`, which resolves to `/app/data/drama-warden.sqlite` in Compose; set `database.sqlitePath` to change it. Compose stores the database in the `drama-warden-data` named volume. `DB_DRIVER` and `SQLITE_PATH` environment variables override these values.

## MySQL

The MySQL adapter targets MySQL 8.0.16 or later and uses the `mysql2/promise` connection pool. Standard `npm ci` includes optional dependencies. If installation used `--omit=optional`, install the MySQL driver with `npm install --no-save mysql2` before selecting `database.driver: mysql`. Configure non-secret host, port, database, user, and pool settings under `database.mysql`; set `MYSQL_PASSWORD` in `.env` or the process environment.

The bundled Compose server is optional and starts only with its profile:

```sh
# Set database.driver to mysql in config/config.yaml and nonempty MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD in .env first.
docker compose --profile mysql up --build
```

The bundled MySQL service uses `MYSQL_DATABASE` and `MYSQL_USER` from `.env` when set, with defaults matching `config/config.example.yaml`. If you change `database.mysql.database` or `database.mysql.user` for the bundled service, set the matching `MYSQL_DATABASE` or `MYSQL_USER` in `.env` so the application and MySQL container use the same values. Database passwords are never read from YAML.

The application waits for the server during startup, creates a version table, then applies the v1 schema and additive v2, v3, and v4 migrations. The database and application user must already exist and the user must be allowed to create tables and indexes. Compose creates them for its bundled MySQL service. Schema creation is idempotent if startup is interrupted before the migration version is recorded. V3 adds `application_setting` for non-secret runtime options such as scheduler settings. V4 adds `plugin_call_log`, which stores capability, source, correlation ID, outcome, stable error code, duration, and timestamp without input or response content.

Schema migration initializes an empty MySQL database; it does not automatically copy data from SQLite. Use the portable export/import commands below to move application records between SQLite and MySQL. Back up each database with its matching tool before upgrade or transfer. The MySQL connection values are secrets or infrastructure details: keep them in a private environment file and out of Git.

## Move application records between database drivers

The portable transfer command copies application database records while preserving row IDs and uncertain-write states. New exports use schema version 4 and include plugin-call audit history; imports also accept version 3 snapshots and initialize the audit table empty. SQLite and MySQL support both directions. It does not copy media files, provider CLI credentials, environment configuration, or the source database itself.

SQLite export opens the existing file in read-only mode and refuses a missing or pre-v4 source database. Start the application once before exporting an older database so its normal migrations can complete, then stop it and export.

Stop the application before starting a transfer and keep a separate database/volume backup. The CLI reads `.env` in its working directory when present; process environment variables take precedence. Set `DRAMA_WARDEN_ENV_FILE` to use a different environment file. It also loads the configured YAML defaults before opening the database. Export to a protected `.backup` file:

```sh
npm run db:export -- --output backups/pre-migration.backup
```

Then configure `DB_DRIVER` and connection settings for the target database. Ensure the target is reachable and its application tables contain no rows, then import:

```sh
npm run db:import -- --input backups/pre-migration.backup
```

The import initializes the target schema if necessary, refuses any target with existing application rows, writes all tables in dependency order inside one transaction, and verifies each table's row count before commit. A failure rolls back the data import; the source is never modified by the import. Start the application only after the import succeeds, then check health and representative shows, events, assets, claims, and subtitle jobs before retiring the source.

For Docker Compose, stop the application and run the command in a one-off application container with a host backup directory mounted at `/migration`:

```sh
mkdir -p backups
docker compose run --rm --no-deps \
  -v "$PWD/backups:/migration" \
  --entrypoint node drama-warden \
  scripts/migrate-database.mjs --output /migration/pre-migration.backup
```

After setting the target connection in `.env`, start the bundled MySQL service if needed, then import with the application still stopped:

```sh
docker compose --profile mysql up -d mysql
docker compose --profile mysql run --rm --no-deps \
  -v "$PWD/backups:/migration:ro" \
  --entrypoint node drama-warden \
  scripts/migrate-database.mjs --input /migration/pre-migration.backup
```

Omit `--profile mysql` when the target is SQLite or an external MySQL server. The file contains event payloads such as share URLs and must remain private. The command creates it with mode `0600`, refuses to overwrite an existing file, and requires the `.backup` suffix so the repository, Docker, and npm filters exclude it.

The transfer format is versioned and exports the current database schema. Imports validate the complete schema represented by the snapshot, including compatible v3 snapshots that predate plugin-call audit records. Dates are normalized to UTC when crossing the SQLite text and MySQL `DATETIME` representations. It does not perform a live migration or remove/alter either database.

See [backup and restore](BACKUP-RESTORE.md) for the Compose volume and bundled MySQL dump procedure.

MySQL's indexed path columns currently limit storage root paths to 600 characters and asset keys to 700 characters. Requests exceeding MySQL column limits are rejected before insertion.

The MySQL 8.4 integration suite verifies versioned migrations, repeated startup, repository writes, subtitle job creation/claim, complete storage snapshot scans, and the core follow-up workflow through test storage and indexer ports. It also verifies that a pre-write incomplete destination listing releases claims for a safe retry, while a post-write unconfirmed index result marks claims uncertain and blocks retry. It does not exercise vendor CLIs, external subtitle APIs, production credentials, or backup/restore. The isolated Compose backup/restore rehearsal and its limits are recorded in [backup and restore](BACKUP-RESTORE.md).
