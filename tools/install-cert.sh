#!/usr/bin/env bash
#
# Turn the files a CA hands you into the three the demonstrator needs.
#
# A TLS setup has exactly three parts:
#
#   certificate  the one issued for your hostname ("leaf")     -> SSL_CERT_PATH
#   chain        the CA certificates above it ("intermediates")-> SSL_INT_PATH
#   private key  YOUR secret, created when the request was made-> SSL_KEY_PATH
#
# CAs usually deliver the first two glued together in a "bundle", and never send
# the key -- you already have it, because you generated it. This splits a bundle
# into certificate + chain, checks the pieces actually belong together, and
# writes them where the framework expects.
#
# Usage:
#   tools/install-cert.sh --bundle FILE [--key FILE] [--dest DIR]
#   tools/install-cert.sh --pkcs7  FILE [--key FILE] [--dest DIR]
#
set -uo pipefail

BUNDLE=""; PKCS7=""; KEY=""; DEST="src/webserver/cert"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --bundle) BUNDLE="$2"; shift 2 ;;
        --pkcs7)  PKCS7="$2";  shift 2 ;;
        --key)    KEY="$2";    shift 2 ;;
        --dest)   DEST="$2";   shift 2 ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

problems=0
ok()   { printf '  ok     %s\n' "$1"; }
bad()  { printf '  FAIL   %s\n' "$1"; problems=$((problems+1)); }
warn() { printf '  warn   %s\n' "$1"; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# --- gather every certificate we were given, one file each -----------------
if [[ -n "$PKCS7" ]]; then
    [[ -f "$PKCS7" ]] || { echo "no such file: $PKCS7" >&2; exit 1; }
    openssl pkcs7 -print_certs -in "$PKCS7" -out "$tmp/all.pem" 2>/dev/null \
        || { echo "could not read $PKCS7 as PKCS#7" >&2; exit 1; }
elif [[ -n "$BUNDLE" ]]; then
    [[ -f "$BUNDLE" ]] || { echo "no such file: $BUNDLE" >&2; exit 1; }
    cp "$BUNDLE" "$tmp/all.pem"
else
    echo "give me --bundle or --pkcs7 (see --help)" >&2; exit 2
fi

awk -v d="$tmp" 'BEGIN{n=0}
    /-----BEGIN CERTIFICATE-----/{n++; f=sprintf("%s/c%02d.pem", d, n)}
    n>0 {print > f}' "$tmp/all.pem"

certs=("$tmp"/c*.pem)
[[ -e "${certs[0]}" ]] || { echo "no certificates found in the input" >&2; exit 1; }
echo "=== read ${#certs[@]} certificate(s) ==="

subj_of()  { openssl x509 -in "$1" -noout -subject | sed 's/^subject=//'; }
issu_of()  { openssl x509 -in "$1" -noout -issuer  | sed 's/^issuer=//'; }
is_ca()    { openssl x509 -in "$1" -noout -text | grep -A1 'X509v3 Basic Constraints' | grep -q 'CA:TRUE'; }

# --- find the leaf: the one that is not a CA -------------------------------
LEAF=""
for c in "${certs[@]}"; do
    if ! is_ca "$c"; then LEAF="$c"; break; fi
done
if [[ -z "$LEAF" ]]; then
    bad "no end-entity certificate here (every certificate is a CA). This looks
         like a chain-only file; you also need the one issued for your hostname."
    exit 1
fi
cn=$(subj_of "$LEAF" | tr ',' '\n' | grep -o 'CN=.*' | head -1)
ok "certificate for ${cn:-?}"

sans=$(openssl x509 -in "$LEAF" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ')
[[ -n "$sans" ]] && ok "valid for: $sans"

if openssl x509 -in "$LEAF" -noout -checkend 0 >/dev/null 2>&1; then
    ok "not expired (until $(openssl x509 -in "$LEAF" -noout -enddate | sed 's/notAfter=//'))"
else
    warn "EXPIRED or not yet valid: $(openssl x509 -in "$LEAF" -noout -dates | tr '\n' ' ')
         browsers will reject it. Fine for a dry run, not for a demo."
fi

# --- order the chain by following issuer -> subject -------------------------
chain=()
want=$(issu_of "$LEAF")
while :; do
    next=""
    for c in "${certs[@]}"; do
        [[ "$c" == "$LEAF" ]] && continue
        for used in "${chain[@]:-}"; do [[ "$c" == "$used" ]] && continue 2; done
        if [[ "$(subj_of "$c")" == "$want" ]]; then next="$c"; break; fi
    done
    [[ -z "$next" ]] && break
    chain+=("$next")
    # a self-signed certificate is the root: nothing above it
    [[ "$(subj_of "$next")" == "$(issu_of "$next")" ]] && break
    want=$(issu_of "$next")
done

if [[ ${#chain[@]} -eq 0 ]]; then
    warn "no intermediates found. If the certificate was issued directly by a
         root that is fine; otherwise offline devices will reject it, because
         they cannot download the missing piece themselves."
else
    ok "chain of ${#chain[@]}, in order:"
    for c in "${chain[@]}"; do
        printf '           %s\n' "$(subj_of "$c" | tr ',' '\n' | grep -o 'CN=.*' | head -1)"
    done
fi

leftover=$(( ${#certs[@]} - 1 - ${#chain[@]} ))
(( leftover > 0 )) && warn "$leftover certificate(s) in the file are not part of this chain; ignored"

# --- the private key --------------------------------------------------------
echo
echo "=== private key ==="
if [[ -z "$KEY" ]]; then
    bad "not supplied. A certificate alone cannot serve HTTPS: it is the public
         half. The private half was created when the signing request was made,
         so look wherever that happened -- it is NOT something the CA sends you.
         Re-run with --key /path/to/privkey.pem"
elif [[ ! -f "$KEY" ]]; then
    bad "no such file: $KEY"
else
    if grep -q "ENCRYPTED" "$KEY"; then
        bad "the key is passphrase-protected; daphne cannot unlock it. Strip it:
         openssl rsa -in $KEY -out privkey_nopass.pem"
    else
        cmod=$(openssl x509 -in "$LEAF" -noout -modulus 2>/dev/null | openssl md5)
        kmod=$(openssl rsa  -in "$KEY"  -noout -modulus 2>/dev/null | openssl md5)
        if [[ -n "$kmod" && "$cmod" == "$kmod" ]]; then
            ok "matches this certificate"
        elif [[ -z "$kmod" ]]; then
            warn "could not read as an RSA key (an EC key?); skipping the match check"
        else
            bad "does NOT match this certificate -- it belongs to a different one"
        fi
    fi
fi

# --- write the files --------------------------------------------------------
if (( problems > 0 )); then
    echo
    echo "Not writing anything until the above is resolved."
    exit 1
fi

mkdir -p "$DEST"
cp "$LEAF" "$DEST/cert.pem"
if [[ ${#chain[@]} -gt 0 ]]; then cat "${chain[@]}" > "$DEST/chain.pem"; fi
[[ -n "$KEY" ]] && { cp "$KEY" "$DEST/privkey.pem"; chmod 600 "$DEST/privkey.pem"; }

echo
echo "=== wrote ==="
ok "$DEST/cert.pem      (the certificate)"
[[ ${#chain[@]} -gt 0 ]] && ok "$DEST/chain.pem     (the chain, in order)"
[[ -n "$KEY" ]] && ok "$DEST/privkey.pem   (your private key, mode 600)"

if git check-ignore -q "$DEST/privkey.pem" 2>/dev/null; then
    ok "the key is git-ignored"
else
    warn "$DEST is not git-ignored -- do not commit the private key."
fi

cat <<EOM

=== use it ===
Point the server at these, e.g. in compose.yaml or the environment:

  SSL_CERT_PATH=$DEST/cert.pem
  SSL_KEY_PATH=$DEST/privkey.pem
  SSL_INT_PATH=$DEST/chain.pem

Then check what actually reaches a browser:

  tools/check-cert.sh --cert $DEST/cert.pem --key $DEST/privkey.pem \\
                      --chain $DEST/chain.pem --probe YOUR_HOST:8000
EOM
