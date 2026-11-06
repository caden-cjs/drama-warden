FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS app-build

WORKDIR /app
ENV npm_config_nodedir=/usr/local
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/plugin-sdk ./packages/plugin-sdk
RUN npm ci
COPY frontend ./frontend
COPY vite.config.js ./vite.config.js
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30

COPY --from=app-build /usr/local/bin/node /usr/local/bin/node
COPY --from=app-build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

ENV NODE_ENV=production
ENV PORT=8080
# The pinned Quark CLI's built-in guard disables auth-trace initialization and reporting.
ENV QK_E2E_ACTIVE=1 \
    QK_E2E_WPK=0
ARG INCLUDE_115_CLI=false
ARG INCLUDE_QUARK_CLI=false
ARG QUARK_CLI_PATH=/opt/quarkclouddrive/scripts/quark-drive.cjs
ARG QUARK_CLI_VERSION=1.0.25-876f30d
ARG QUARK_CLI_URL=https://pdds.quark.cn/download/stfile/eekkigineefiegmgo/quarkclouddrive-1.0.25.zip
ARG QUARK_CLI_SHA256=56c34e9a9313ae29d39475b4ff9da9e92fbfd59699bf5843e3382e54434fffb8
COPY third-party/115cli/requirements.lock /tmp/115cli-requirements.lock

ENV QUARK_SKILL_DIR=/opt/quarkclouddrive \
    QUARK_STATE_DIR=/app/data/.quarkclouddrive \
    HOME=/app/data \
    TZ=Asia/Shanghai

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl jq unzip tzdata libstdc++6 libgcc-s1 \
    && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && node --version \
    && npm --version \
    && if [ "$INCLUDE_115_CLI" = "true" ]; then \
      python -m pip install --no-cache-dir --disable-pip-version-check --only-binary=:all: --require-hashes -r /tmp/115cli-requirements.lock \
      && 115cli --version; \
    elif [ "$INCLUDE_115_CLI" != "false" ]; then \
      echo "INCLUDE_115_CLI must be true or false" >&2; exit 1; \
    fi \
    && rm -f /tmp/115cli-requirements.lock \
    && mkdir -p "$QUARK_SKILL_DIR" \
    && mkdir -p "$QUARK_SKILL_DIR/scripts" \
    && if [ "$INCLUDE_QUARK_CLI" = "true" ]; then \
      curl -fsSL --max-time 120 -o /tmp/quarkclouddrive.zip "$QUARK_CLI_URL" \
      && printf '%s  %s\n' "$QUARK_CLI_SHA256" /tmp/quarkclouddrive.zip | sha256sum -c - \
      && mkdir -p "$(dirname "$QUARK_CLI_PATH")" \
      && unzip -p /tmp/quarkclouddrive.zip scripts/quark-drive.cjs > "$QUARK_CLI_PATH" \
      && unzip -p /tmp/quarkclouddrive.zip scripts/hash-worker.cjs > "$QUARK_SKILL_DIR/scripts/hash-worker.cjs" \
      && chmod 0755 "$QUARK_CLI_PATH" "$QUARK_SKILL_DIR/scripts/hash-worker.cjs" \
      && grep -F 'function Sr(){return process.env.QK_E2E_ACTIVE==="1"&&process.env.QK_E2E_WPK==="0"}' "$QUARK_CLI_PATH" >/dev/null \
      && grep -F 'Sr()&&Fg(de.getInstance())' "$QUARK_CLI_PATH" >/dev/null \
      && grep -F 'Sr()||s.getInstance().setConfig' "$QUARK_CLI_PATH" >/dev/null \
      && grep -F 'Sr()||s.getInstance().reportJSError' "$QUARK_CLI_PATH" >/dev/null \
      && grep -F 'static async flush(){Sr()||!s._instance' "$QUARK_CLI_PATH" >/dev/null \
      && grep -F 'async flushTraces(){if(Sr())return;' "$QUARK_CLI_PATH" >/dev/null \
      && test "$(node "$QUARK_CLI_PATH" --version)" = "$QUARK_CLI_VERSION" \
      && node "$QUARK_CLI_PATH" --help >/dev/null; \
    elif [ "$INCLUDE_QUARK_CLI" != "false" ]; then \
      echo "INCLUDE_QUARK_CLI must be true or false" >&2; exit 1; \
    fi \
    && rm -f /tmp/quarkclouddrive.zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY THIRD-PARTY-NOTICES.md /usr/share/doc/drama-warden/THIRD-PARTY-NOTICES.md
COPY third-party /usr/share/doc/drama-warden/third-party
COPY third-party/quarkclouddrive/LICENSE /usr/share/licenses/quarkclouddrive/LICENSE
COPY third-party/115cli/LICENSE /usr/share/licenses/115cli/LICENSE
COPY package.json package-lock.json ./
COPY packages/plugin-sdk ./packages/plugin-sdk
COPY scripts/migrate-database.mjs ./scripts/migrate-database.mjs
COPY scripts/start.mjs ./scripts/start.mjs
COPY scripts/cli.mjs ./scripts/cli.mjs
COPY config ./config
COPY --from=app-build /app/node_modules ./node_modules
COPY backend ./backend
COPY --from=app-build /app/frontend/dist ./frontend/dist
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin drama-warden \
    && mkdir -p /app/data/.quarkclouddrive /app/data/.115cli/credentials \
    && chown -R drama-warden:drama-warden /app/data \
    && chmod 0700 /app/data/.quarkclouddrive /app/data/.115cli/credentials

USER drama-warden
EXPOSE 8080
CMD ["npm", "start"]
