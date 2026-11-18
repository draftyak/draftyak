FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
RUN rustup component add rustfmt clippy --toolchain 1.95.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends dbus gnome-keyring \
 && rm -rf /var/lib/apt/lists/* \
 && cd /usr/share/dbus-1/services \
 && rm org.freedesktop.secrets.service org.gnome.keyring.service \
    org.freedesktop.impl.portal.Secret.service
