#!/bin/sh
# Session validation, with the macOS TLS fix built in.
#
#   npm run validate        (or: sh tools/validate.sh)
#
# Node ships its own certificate bundle and ignores the macOS keychain. Behind
# a TLS-inspecting proxy or a corporate root CA, every fetch therefore fails
# with "unable to get local issuer certificate" — the app on Vercel is fine,
# only local Node runs are affected. This exports the system keychain to a PEM
# once (refreshed monthly) and points Node at it via NODE_EXTRA_CA_CERTS.
set -e
cd "$(dirname "$0")/.."

PEM="${HOME}/.config/signal-desk/ca.pem"
if [ "$(uname)" = "Darwin" ]; then
  if [ ! -s "$PEM" ] || [ -n "$(find "$PEM" -mtime +30 2>/dev/null)" ]; then
    mkdir -p "$(dirname "$PEM")"
    security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > "$PEM" 2>/dev/null || true
    security find-certificate -a -p /Library/Keychains/System.keychain >> "$PEM" 2>/dev/null || true
    security find-certificate -a -p "${HOME}/Library/Keychains/login.keychain-db" >> "$PEM" 2>/dev/null || true
    echo "exported $(grep -c 'BEGIN CERTIFICATE' "$PEM") certificates from the macOS keychain to $PEM"
  fi
  export NODE_EXTRA_CA_CERTS="$PEM"
fi

case "$1" in
  co|crypto|options) shift; exec node tools/validate-crypto-options.mjs "$@" ;;
  *) exec node tools/validate.mjs "$@" ;;
esac
