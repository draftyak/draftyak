#!/bin/sh
set -eu

stage=setup
report_failure() {
    failure_status=$?
    trap - 0
    if [ "$failure_status" -ne 0 ]; then
        case "$stage" in
            setup|bus|service|default-alias|collections|collections-query|collections-shape|collections-empty|unlocked|lock|locked|command)
                printf 'DYTEST linux-store failed stage=%s\n' "$stage" >&2 || :
                ;;
        esac
    fi
    exit "$failure_status"
}
trap report_failure 0

session=false
if [ "${1-}" = --session ]; then session=true; shift; fi
state=${1-}
shift
case "$state" in healthy|no-bus|no-service|no-collection|locked) ;; *) exit 2 ;; esac
[ "$#" -gt 0 ] || exit 2
command -v dbus-send >/dev/null

if [ "$session" = false ]; then
    unset DBUS_SESSION_BUS_ADDRESS DBUS_STARTER_ADDRESS DBUS_STARTER_BUS_TYPE DISPLAY WAYLAND_DISPLAY GNOME_KEYRING_CONTROL
    HOME="/tmp/draftyak-native-store-$state"
    XDG_RUNTIME_DIR="$HOME/runtime"
    XDG_CONFIG_HOME="$HOME/config"
    XDG_DATA_HOME="$HOME/data"
    export HOME XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME
    mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
    chmod 700 "$HOME" "$XDG_RUNTIME_DIR"
    stage=bus
    if [ "$state" != no-bus ]; then
        exec dbus-run-session -- sh "$0" --session "$state" "$@"
    fi
    DBUS_SESSION_BUS_ADDRESS="unix:path=$HOME/absent-bus"
    export DBUS_SESSION_BUS_ADDRESS
    if dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1; then exit 1; fi
else
    stage=bus
    dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null
    stage=service
    case "$state" in
        no-service) ;;
        no-collection) gnome-keyring-daemon --start --components=secrets >/dev/null ;;
        healthy|locked)
            password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
            printf %s "$password" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
            unset password
            ;;
        *) exit 2 ;;
    esac
    service_owner() {
        dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets
    }
    if [ "$state" = no-service ]; then
        reply=$(service_owner) || exit 1
        printf '%s\n' "$reply" | grep -Eq '^[[:space:]]*boolean false$' || exit 1
    else
        tries=0
        while :; do
            reply=$(service_owner) || exit 1
            if printf '%s\n' "$reply" | grep -Eq '^[[:space:]]*boolean true$'; then break; fi
            printf '%s\n' "$reply" | grep -Eq '^[[:space:]]*boolean false$' || exit 1
            tries=$((tries + 1))
            [ "$tries" -le 200 ] || exit 1
            sleep 0.05
        done
        stage=default-alias
        alias_reply=$(dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.ReadAlias string:default) || exit 1
        collection=$(printf '%s\n' "$alias_reply" | sed -n 's/^[[:space:]]*object path "\([/a-zA-Z0-9_]*\)"$/\1/p')
        if [ "$state" = no-collection ]; then
            [ "$collection" = / ] || exit 1
        else
            case "$collection" in /org/freedesktop/secrets/collection/?*) ;; *) exit 1 ;; esac
            is_locked() {
                reply=$(dbus-send --session --print-reply --dest=org.freedesktop.secrets "$collection" org.freedesktop.DBus.Properties.Get string:org.freedesktop.Secret.Collection string:Locked) || return 1
                printf '%s\n' "$reply" | grep -Eq "^[[:space:]]*variant[[:space:]]+boolean $1$"
            }
            stage=unlocked
            is_locked false || exit 1
            if [ "$state" = locked ]; then
                stage=lock
                dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.Lock "array:objpath:$collection" >/dev/null
                stage=locked
                is_locked true || exit 1
            fi
        fi
    fi
fi

stage=command
DRAFTYAK_NATIVE_STORE_TEST=secret-service
export DRAFTYAK_NATIVE_STORE_TEST
if [ "$state" = healthy ]; then
    unset DRAFTYAK_NATIVE_STORE_FAILURE_STATE
else
    DRAFTYAK_NATIVE_STORE_FAILURE_STATE=$state
    export DRAFTYAK_NATIVE_STORE_FAILURE_STATE
fi
printf 'DYTEST linux-store verified state=%s\n' "$state"
exec "$@"
