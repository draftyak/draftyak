# The Linux side of S5a: Rust 1.95.0 on Debian 12 with a session bus and gnome-keyring, for the
# Secret Service store (test/ekm.heavy.test.ts builds it with the kit's buildImage). Without the
# D-Bus activation files, no Secret Service starts unless the test starts gnome-keyring itself.
FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
RUN apt-get update \
 && apt-get install -y --no-install-recommends dbus gnome-keyring \
 && rm -rf /var/lib/apt/lists/* \
 && cd /usr/share/dbus-1/services \
 && rm org.freedesktop.secrets.service org.gnome.keyring.service \
    org.freedesktop.impl.portal.Secret.service
