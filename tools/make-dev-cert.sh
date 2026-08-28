#!/usr/bin/env bash
#
# Generate a self-signed TLS certificate for local development.
#
# No certificate ships with the framework. This generates one that is valid for
# the hostnames you actually use, so the only complaint a browser has left is
# the untrusted issuer -- a single click-through exception per browser.
#
# Usage:
#   tools/make-dev-cert.sh [extra-hostname-or-ip ...]
#
# localhost, 127.0.0.1, ::1 and this machine's hostname are always included.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${REPO_ROOT}/src/webserver/cert"
DAYS="${DAYS:-825}"

mkdir -p "${CERT_DIR}"

names=(localhost "$(hostname)" "$(hostname -f 2>/dev/null || true)" "$@")
ips=(127.0.0.1 ::1)

# Split the collected entries into DNS: and IP: SAN entries, dropping blanks
# and duplicates.
san_entries=()
seen=""
add_san() {
    local kind="$1" value="$2"
    [[ -z "${value}" ]] && return
    case " ${seen} " in *" ${kind}:${value} "*) return ;; esac
    seen="${seen} ${kind}:${value}"
    san_entries+=("${kind}:${value}")
}

for n in "${names[@]}"; do
    if [[ "${n}" =~ ^[0-9.]+$ || "${n}" =~ : ]]; then
        add_san IP "${n}"
    else
        add_san DNS "${n}"
    fi
done
for i in "${ips[@]}"; do
    add_san IP "${i}"
done

SAN="$(IFS=,; printf '%s' "${san_entries[*]}")"

echo "Generating a ${DAYS}-day self-signed certificate"
echo "  subjectAltName = ${SAN}"

openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
    -days "${DAYS}" \
    -keyout "${CERT_DIR}/privkey.pem" \
    -out "${CERT_DIR}/cert.pem" \
    -subj "/CN=$(hostname)/O=Speech Enhancement Demo (development)" \
    -addext "subjectAltName=${SAN}" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" \
    2>/dev/null

chmod 600 "${CERT_DIR}/privkey.pem"
chmod 644 "${CERT_DIR}/cert.pem"

echo
echo "Wrote:"
echo "  ${CERT_DIR}/cert.pem"
echo "  ${CERT_DIR}/privkey.pem"
echo
openssl x509 -in "${CERT_DIR}/cert.pem" -noout -subject -dates -ext subjectAltName
echo
echo "Restart the server, then open the demo once and accept the certificate."
echo "Because the page and the signaling WebSocket now share one origin, that"
echo "single exception is enough -- in Firefox and Safari too."
