# Derived from OpenMausBot server/container-computer.ts (Apache-2.0).
# See third-party/openmausbot. Local changes: Yaoyao image metadata.
FROM docker.io/trycua/xfce-cua@sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b
USER root
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) wheel_url='https://files.pythonhosted.org/packages/fa/d7/a43008a328a40c85e7bc706fc20235b9abedc75e28b413817655153157ff/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl'; wheel_sha='f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961'; wheel_path='/tmp/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl'; lib_triplet='x86_64-linux-gnu' ;; \
      aarch64|arm64) wheel_url='https://files.pythonhosted.org/packages/94/9d/1c1838b69067e83266c3d2aae02d74eef353a43dc8644884ccf03fe7f933/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl'; wheel_sha='48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77'; wheel_path='/tmp/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl'; lib_triplet='aarch64-linux-gnu' ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    for ssl_lib in "/lib/$lib_triplet/libssl.so.3" "/lib/$lib_triplet/libcrypto.so.3"; do \
      if [ -e "$ssl_lib" ] && [ ! -s "$ssl_lib" ]; then \
        echo "pinned base image is defective on $arch: $ssl_lib is zero bytes, so curl cannot start — re-pull or replace the base image instead of debugging the wheel download" >&2; \
        exit 1; \
      fi; \
    done; \
    curl -fsSL "$wheel_url" -o "$wheel_path"; \
    echo "$wheel_sha  $wheel_path" | sha256sum -c -; \
    /opt/venv/bin/python -m pip install --no-cache-dir --force-reinstall --no-deps "$wheel_path"; \
    rm -f "$wheel_path"; \
    driver_bin="$(find /opt/venv/lib -path '*/cua_driver/bin/cua-driver' -type f -print -quit)"; \
    test -n "$driver_bin"; \
    install -D -m 0755 "$driver_bin" /usr/local/libexec/openmausbot/cua-driver; \
    install -d -o cua -g cua -m 0700 /home/cua/workspace; \
    test "$(/usr/local/libexec/openmausbot/cua-driver --version)" = "cua-driver 0.20.0"
# Install before XFCE starts so the panel and window manager see the font too.
# Noto Sans CJK JP is distributed under the SIL Open Font License 1.1.
RUN set -eux; \
    install -d -m 0755 /usr/local/share/fonts; \
    curl -fsSL 'https://raw.githubusercontent.com/notofonts/noto-cjk/165c01b46ea533872e002e0785ff17e44f6d97d8/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf' -o /usr/local/share/fonts/NotoSansCJKjp-Regular.otf; \
    echo '68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5  /usr/local/share/fonts/NotoSansCJKjp-Regular.otf' | sha256sum -c -; \
    chmod 0644 /usr/local/share/fonts/NotoSansCJKjp-Regular.otf; \
    install -d -m 0755 /usr/local/share/licenses/noto-cjk; \
    curl -fsSL 'https://raw.githubusercontent.com/notofonts/noto-cjk/165c01b46ea533872e002e0785ff17e44f6d97d8/LICENSE' -o /usr/local/share/licenses/noto-cjk/OFL.txt; \
    echo '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2  /usr/local/share/licenses/noto-cjk/OFL.txt' | sha256sum -c -; \
    fc-cache -f
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -eu' \
      'workspace=/home/cua/workspace' \
      'profiles="$workspace/.browser-profiles"' \
      'mkdir -p "$profiles/google-chrome" "$profiles/chromium" "$HOME/.config"' \
      'if ! chmod 0700 "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium" 2>/dev/null; then' \
      '  for directory in "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium"; do' \
      '    test -r "$directory" && test -w "$directory" && test -x "$directory"' \
      '  done' \
      'fi' \
      'migrate_profile() {' \
      '  name="$1"' \
      '  source="$HOME/.config/$name"' \
      '  target="$profiles/$name"' \
      '  if [ -d "$source" ] && [ ! -L "$source" ] && [ -z "$(find "$target" -mindepth 1 -print -quit)" ]; then' \
      '    cp -a "$source"/. "$target"/' \
      '  fi' \
      '  rm -rf "$source"' \
      '  ln -s "$target" "$source"' \
      '}' \
      'migrate_profile google-chrome' \
      'migrate_profile chromium' \
      'find "$profiles" \( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie -o -name .parentlock \) -delete' \
      > /usr/local/bin/prepare-openmausbot-workspace.sh \
    && chmod 0755 /usr/local/bin/prepare-openmausbot-workspace.sh
RUN printf '%s\n' \
      '#!/bin/sh' \
      '/usr/local/bin/prepare-openmausbot-workspace.sh' \
      'attempt=0' \
      'until DISPLAY=:1 xset q >/dev/null 2>&1; do' \
      '  attempt=$((attempt + 1))' \
      '  if [ "$attempt" -ge 45 ]; then echo "X display :1 did not become ready within 45 seconds" >&2; exit 1; fi' \
      '  sleep 1' \
      'done' \
      'exec env CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 /usr/local/libexec/openmausbot/cua-driver serve --socket /run/user/1000/openmausbot-cua.sock --permission-mode standard' \
      > /usr/local/bin/start-openmausbot-cua-driver.sh \
    && chmod 0755 /usr/local/bin/start-openmausbot-cua-driver.sh
RUN printf '%s\n' \
      '' \
      '[program:openmausbot-cua-driver]' \
      'command=/usr/local/bin/start-openmausbot-cua-driver.sh' \
      'user=cua' \
      'environment=HOME="/home/cua",USER="cua",DISPLAY=":1"' \
      'autorestart=true' \
      'startsecs=2' \
      'stdout_logfile=/var/log/supervisor/cua-driver.log' \
      'stderr_logfile=/var/log/supervisor/cua-driver.error.log' \
      'priority=30' \
      >> /etc/supervisor/supervisord.conf
LABEL com.openmausbot.local-vm="1" \
      com.openmausbot.cua-driver="0.20.0" \
      com.openmausbot.cua-base="sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b" \
      com.openmausbot.image-layer="5"

LABEL cn.samien.yaoyao.computer-image="1"
COPY prepare-firefox.sh /usr/local/bin/prepare-yaoyao-firefox.sh
RUN chmod 0755 /usr/local/bin/prepare-yaoyao-firefox.sh \
    && sed -i '2i /usr/local/bin/prepare-yaoyao-firefox.sh || exit 1' /usr/local/bin/start-openmausbot-cua-driver.sh

COPY compose_bridge.py /usr/local/libexec/yaoyao/compose_bridge.py
COPY skill_bundle.py /usr/local/libexec/yaoyao/skill_bundle.py
RUN printf '\n[program:yaoyao-compose-desktop]\ncommand=python3 /usr/local/libexec/yaoyao/compose_bridge.py\nuser=root\nautorestart=unexpected\nexitcodes=0\nstartsecs=0\nstdout_logfile=/var/log/supervisor/yaoyao-compose.log\nstderr_logfile=/var/log/supervisor/yaoyao-compose.error.log\npriority=40\n' >> /etc/supervisor/supervisord.conf
LABEL cn.samien.yaoyao.compose-desktop="1"
