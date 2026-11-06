#!/bin/sh
set -eu

image="${1:-}"
if [ -z "$image" ]; then
  printf '%s\n' 'usage: smoke-default-image.sh IMAGE' >&2
  exit 2
fi

smoke_value='ci-smoke-only'
container_id=''

cleanup() {
  if [ -n "$container_id" ]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

container_id="$(docker run --detach \
  --mount type=tmpfs,destination=/app/data,tmpfs-mode=1777 \
  --mount type=tmpfs,destination=/local-shares,tmpfs-mode=0755 \
  --env "API_ACCESS_TOKEN=$smoke_value" \
  --env LOCAL_STORAGE_ROOT=/app/data/media \
  --env LOCAL_STORAGE_SHARE_ROOT=/local-shares \
  --publish 127.0.0.1::8080 \
  "$image")"

if ! port_mapping="$(docker port "$container_id" 8080/tcp 2>/dev/null)"; then
  docker logs "$container_id" >&2 || true
  exit 1
fi
port="${port_mapping##*:}"
case "$port" in
  ''|*[!0-9]*)
    printf '%s\n' 'Docker did not assign a valid local port' >&2
    exit 1
    ;;
esac
base_url="http://127.0.0.1:$port"

attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl --fail --silent "$base_url/api/health" >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$attempt" -ge 30 ]; then
  docker logs "$container_id" >&2
  exit 1
fi

docker exec "$container_id" sh -ec '
  if command -v 115cli >/dev/null 2>&1; then exit 1; fi
  if python -m pip show p115cipher >/dev/null 2>&1; then exit 1; fi
  test "$QK_E2E_ACTIVE" = "1"
  test "$QK_E2E_WPK" = "0"
  test ! -e /opt/quarkclouddrive/scripts/quark-drive.cjs
'

unauthorized_status="$(curl --silent --show-error --output /dev/null \
  --write-out '%{http_code}' "$base_url/api/plugins")"
if [ "$unauthorized_status" != '401' ]; then
  printf 'expected unauthenticated /api/plugins to return 401; got %s\n' "$unauthorized_status" >&2
  exit 1
fi

curl --fail --silent --show-error \
  --header "Authorization: Bearer $smoke_value" \
  "$base_url/api/plugins" >/dev/null

printf '%s\n' 'default Docker image health, API auth, and optional CLI checks passed'
