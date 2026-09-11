#!/bin/sh
set -eu
if [ "${HTTP_PROXY:-}" = 'http://127.0.0.1:3128' ]; then
    set -- "--proxy-server=$HTTP_PROXY" '--proxy-bypass-list=localhost;127.0.0.1;[::1]' --disable-quic "$@"
fi
exec /usr/bin/google-chrome --no-sandbox --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic --user-data-dir=/home/cua/workspace/.browser-profiles/google-chrome "$@"
