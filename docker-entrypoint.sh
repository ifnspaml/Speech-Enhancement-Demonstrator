#!/usr/bin/env bash
#
# Starts the demonstrator: redis, then a single daphne process that serves the
# Django pages, the static files and the signaling WebSocket.
#
set -euo pipefail

cd "${APP_DIR:-/home/app/src/webserver}"

# --- transport --------------------------------------------------------------
# SERVE_PROTOCOL=https (default) or http.
#
# Plain HTTP is for localhost use only. Browsers gate getUserMedia,
# AudioWorklet, RTCPeerConnection and the wake lock behind a "secure context",
# which means https:// OR http://localhost. Over http:// to a hostname or LAN
# address those APIs are simply absent, so the demo cannot record anything --
# it does not merely warn, it stops working. Useful for a single-machine demo,
# or for a phone reached through `adb reverse tcp:8000 tcp:8000`, where the
# handset genuinely sees http://localhost.
SERVE_PROTOCOL="${SERVE_PROTOCOL:-https}"

case "${SERVE_PROTOCOL}" in
    https|http) ;;
    *) echo "[entrypoint] SERVE_PROTOCOL must be 'https' or 'http', got '${SERVE_PROTOCOL}'" >&2
       exit 1 ;;
esac

# --- TLS material -----------------------------------------------------------
# Prefer certificates mounted by compose (real, CA-issued). Fall back to the
# self-signed pair in the repo for local development.
DEFAULT_CERT="cert/cert.pem"
DEFAULT_KEY="cert/privkey.pem"

CERT_PATH="${SSL_CERT_PATH:-}"
KEY_PATH="${SSL_KEY_PATH:-}"
INT_PATH="${SSL_INT_PATH:-}"

# -f as well as -r: when the host path in compose.yaml does not exist, Docker
# creates a *directory* at the mount point, which is readable but not a
# certificate. Without the -f test daphne dies with IsADirectoryError.
usable_file() { [[ -n "$1" && -f "$1" && -r "$1" ]]; }

if [[ "${SERVE_PROTOCOL}" == "http" ]]; then
    echo "[entrypoint] serving PLAIN HTTP (no certificate, no warning screen)"
    echo "[entrypoint] microphone capture only works via http://localhost --"
    echo "[entrypoint] browsers withhold getUserMedia from insecure origins."
elif usable_file "${CERT_PATH}" && usable_file "${KEY_PATH}"; then
    echo "[entrypoint] using mounted certificate: ${CERT_PATH}"
else
    if [[ -n "${CERT_PATH}" || -n "${KEY_PATH}" ]]; then
        echo "[entrypoint] WARNING: SSL_CERT_PATH/SSL_KEY_PATH set but not a readable file;" \
             "falling back to the self-signed development certificate."
    fi
    CERT_PATH="${DEFAULT_CERT}"
    KEY_PATH="${DEFAULT_KEY}"
    INT_PATH=""
    echo "[entrypoint] using self-signed development certificate: ${CERT_PATH}"
    echo "[entrypoint] browsers will require a one-time exception for this origin."
fi

# Twisted endpoint strings escape ':' inside values as '\:'.
esc() { printf '%s' "$1" | sed 's/:/\\:/g'; }

build_endpoint() {
    local port="$1"

    if [[ "${SERVE_PROTOCOL}" == "http" ]]; then
        printf 'tcp:%s' "${port}"
        return
    fi

    local ep="ssl:${port}:privateKey=$(esc "${KEY_PATH}"):certKey=$(esc "${CERT_PATH}")"
    if usable_file "${INT_PATH}"; then
        ep="${ep}:extraCertChain=$(esc "${INT_PATH}")"
    fi
    printf '%s' "${ep}"
}

# --- application setup ------------------------------------------------------
chmod +x ./repairdatabase.sh
./repairdatabase.sh
python manage.py shell < newRoom.txt

# The management pages require a staff account. Creating one by hand inside a
# throwaway `docker run` writes it to that container's database, not the one
# mounted here -- which looks exactly like a wrong password later. This creates
# it in the database the server actually uses, and does nothing if it exists.
if [[ -n "${DJANGO_SUPERUSER_USERNAME:-}" && -n "${DJANGO_SUPERUSER_PASSWORD:-}" ]]; then
    python manage.py createsuperuser --noinput 2>/dev/null \
        && echo "[entrypoint] created staff account '${DJANGO_SUPERUSER_USERNAME}'" \
        || echo "[entrypoint] staff account '${DJANGO_SUPERUSER_USERNAME}' already present"
fi

redis-server --daemonize yes

# --- serve ------------------------------------------------------------------
# HTTP_PORT is the origin the demo is used from. WS_PORT stays bound so links
# that still point at the old signaling port keep working; it serves the full
# application too, so it is a valid origin on its own.
HTTP_PORT="${HTTP_PORT:-8000}"
WS_PORT="${WS_PORT:-8001}"

echo "[entrypoint] serving ${SERVE_PROTOCOL} + WebSocket on ports ${HTTP_PORT} and ${WS_PORT}"

exec daphne \
    -e "$(build_endpoint "${HTTP_PORT}")" \
    -e "$(build_endpoint "${WS_PORT}")" \
    webserver.asgi:application
