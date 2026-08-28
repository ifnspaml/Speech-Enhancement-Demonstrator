#!/usr/bin/env bash
#
# Pre-flight check for the TLS material, aimed at an offline demo.
#
# A browser needs three things to accept the certificate without a warning, and
# none of them require internet access:
#   1. the leaf must chain to a root already in the device's trust store,
#      which means the SERVER must send the intermediate(s) -- offline clients
#      cannot fetch them via the certificate's AIA URL
#   2. the current date must be inside the certificate's validity window
#   3. the hostname the device types must be covered by the certificate's SANs
#
# Usage:
#   tools/check-cert.sh [--cert F] [--key F] [--chain F] [--probe HOST:PORT]
#
set -uo pipefail

CERT="${SSL_CERT_PATH:-src/webserver/cert/cert.pem}"
KEY="${SSL_KEY_PATH:-src/webserver/cert/privkey.pem}"
CHAIN="${SSL_INT_PATH:-}"
PROBE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --cert)  CERT="$2"; shift 2 ;;
        --key)   KEY="$2"; shift 2 ;;
        --chain) CHAIN="$2"; shift 2 ;;
        --probe) PROBE="$2"; shift 2 ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

problems=0
note() { printf '  %-6s %s\n' "$1" "$2"; }
ok()   { note "ok" "$1"; }
bad()  { note "FAIL" "$1"; problems=$((problems+1)); }
warn() { note "warn" "$1"; }

# PEM or DER? Twisted reads these as text, so a DER file crashes daphne at
# startup with a UnicodeDecodeError. .cer files are commonly DER.
encoding_of() {
    if grep -q -- "-----BEGIN" "$1" 2>/dev/null; then echo PEM; else echo DER; fi
}

check_encoding() {
    local label="$1" path="$2"
    local enc; enc=$(encoding_of "$path")
    if [[ "$enc" == "PEM" ]]; then
        ok "$label is PEM"
    else
        bad "$label is DER, which daphne cannot read. Convert it:"
        printf '         openssl x509 -inform DER -in %s -out %s.pem\n' "$path" "$path"
    fi
}

echo "=== files ==="
for pair in "certificate:$CERT" "private key:$KEY"; do
    label="${pair%%:*}"; path="${pair#*:}"
    if [[ -f "$path" && -r "$path" ]]; then ok "$label: $path"
    else bad "$label missing or unreadable: $path"; fi
done
if [[ -n "$CHAIN" ]]; then
    if [[ -f "$CHAIN" && -r "$CHAIN" ]]; then ok "chain: $CHAIN"
    else bad "chain missing or unreadable: $CHAIN"; fi
else
    warn "no chain file given (--chain). If the certificate is not issued
         directly by a root, offline devices will reject it: they cannot
         download the intermediate."
fi

[[ -f "$CERT" ]] || { echo; echo "cannot continue without the certificate"; exit 1; }

echo
echo "=== encoding ==="
check_encoding "certificate" "$CERT"
[[ -f "$KEY" ]] && check_encoding "private key" "$KEY"
[[ -n "$CHAIN" && -f "$CHAIN" ]] && check_encoding "chain" "$CHAIN"

echo
echo "=== certificate ==="
subject=$(openssl x509 -in "$CERT" -noout -subject 2>/dev/null | sed 's/^subject=//')
issuer=$(openssl x509 -in "$CERT" -noout -issuer 2>/dev/null | sed 's/^issuer=//')
sans=$(openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ')
note "subj" "$subject"
note "issuer" "$issuer"

if [[ "$subject" == "$issuer" ]]; then
    warn "self-signed: every device will show a warning unless it has this
         certificate installed. For a public demo use a CA-issued one."
fi

if openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null 2>&1; then
    notafter=$(openssl x509 -in "$CERT" -noout -enddate | sed 's/notAfter=//')
    end_epoch=$(date -d "$notafter" +%s 2>/dev/null || echo 0)
    now=$(date +%s)
    if [[ "$end_epoch" != "0" ]]; then
        days=$(( (end_epoch - now) / 86400 ))
        if (( days < 14 )); then warn "expires in $days days ($notafter)"
        else ok "valid for another $days days (until $notafter)"; fi
    else
        ok "not expired (until $notafter)"
    fi
else
    bad "EXPIRED or not yet valid: $(openssl x509 -in "$CERT" -noout -dates | tr '\n' ' ')"
fi

if [[ -n "$sans" ]]; then
    ok "valid for: $sans"
    echo "         ^ devices must reach the Pi at one of these names. With no
           internet there is no DNS, so serve it locally (dnsmasq:
           address=/your.host.name/192.168.x.y) or the browser will report a
           name mismatch."
else
    bad "no subjectAltName: modern browsers reject certificates without one"
fi

echo
echo "=== key matches certificate ==="
if [[ -f "$KEY" ]]; then
    cmod=$(openssl x509 -in "$CERT" -noout -modulus 2>/dev/null | openssl md5)
    kmod=$(openssl rsa -in "$KEY" -noout -modulus 2>/dev/null | openssl md5)
    if [[ -n "$cmod" && "$cmod" == "$kmod" ]]; then ok "private key matches"
    elif [[ -z "$kmod" ]]; then warn "could not read the key as RSA (EC key?); skipping"
    else bad "private key does NOT match the certificate"; fi
fi

echo
echo "=== chain validates against this machine's trust store ==="
if [[ -n "$CHAIN" && -f "$CHAIN" ]]; then
    out=$(openssl verify -untrusted "$CHAIN" "$CERT" 2>&1)
else
    out=$(openssl verify "$CERT" 2>&1)
fi
if grep -q ": OK" <<<"$out"; then ok "chain complete: $out"
else warn "openssl says: $out
         (this machine's roots may differ from a phone's; what matters is that
         the server sends the intermediate -- check with --probe)"
fi

if [[ -n "$PROBE" ]]; then
    echo
    echo "=== live server at $PROBE ==="
    host="${PROBE%%:*}"
    s=$(echo | openssl s_client -connect "$PROBE" -servername "$host" 2>/dev/null)
    n=$(grep -cE "^ *[0-9]+ s:" <<<"$s")
    if (( n > 1 )); then ok "sends $n certificates (leaf + chain)"
    elif (( n == 1 )); then bad "sends only the leaf. Offline devices cannot fetch
         the intermediate and will reject it. Set SSL_INT_PATH."
    else bad "no certificates seen; is it serving TLS on that port?"; fi
    grep "Verify return code" <<<"$s" | head -1 | sed 's/^ */         /'
fi

echo
if (( problems == 0 )); then echo "No blocking problems found."
else echo "$problems blocking problem(s) found."; fi
exit $(( problems > 0 ))
