#!/bin/sh
# S5a's Linux checks, run by test/ekm.heavy.test.ts under --network none in the image from
# ./Dockerfile: the workspace's tests, then the master key store the app picks in five Secret
# Service states. One JSON line per check; DY_PASSPHRASE and DY_KEYRING_PASSWORD come from the test.
set -eu

# The target dir is a volume that every run on this machine shares: one run at a time, so another
# run's build never replaces a binary this run is about to start. The spike's own crates are always
# rebuilt: cargo goes by mtimes, and another worktree's staged copy can be older and still differ.
exec 9>/target/.s05-lock
flock 9

cargo clean --offline --locked -p spike-ekm -p spike-keyring
cargo build --offline --locked --workspace --all-targets
cargo test --offline --locked --workspace
printf '{"check":"packages","dbusVersion":"%s","gnomeKeyringVersion":"%s",'\
'"rustcVersion":"%s","arch":"%s"}\n' \
	"$(dpkg-query -W -f='${Version}' dbus)" "$(dpkg-query -W -f='${Version}' gnome-keyring)" \
	"$(rustc --version | cut -d' ' -f2)" "$(uname -m)"

# Starts gnome-keyring as $1 says (none, start, or unlock with a new login keyring), waits until it
# owns the Secret Service name (it claims it a moment after it returns), then picks a store, with
# mk.wrapped in $2 as the fallback.
session='
case "$1" in
start) gnome-keyring-daemon --start --components=secrets >/dev/null ;;
unlock) printf %s "$DY_KEYRING_PASSWORD" |
	gnome-keyring-daemon --unlock --components=secrets >/dev/null ;;
esac
tries=0
while [ "$1" != none ] && ! dbus-send --session --print-reply --dest=org.freedesktop.DBus \
	/org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets |
	grep -q "boolean true"; do
	tries=$((tries + 1))
	[ "$tries" -le 200 ] || { echo "no Secret Service on the bus after 10 s" >&2; exit 1; }
	sleep 0.05
done
printf "%s\n" "$DY_PASSPHRASE" | /target/debug/spike-keyring select --dir "$2"
'

# state <name> <bus|no-bus> <none|start|unlock> [the state whose home it starts from]
state() {
	echo "{\"check\":\"state\",\"state\":\"$1\"}"
	mkdir -p "/tmp/$1/mk"
	if [ -n "${4-}" ]; then cp -a "/tmp/$4/home" "/tmp/$1/home"; else mkdir -p "/tmp/$1/home"; fi
	if [ "$2" = bus ]; then
		HOME="/tmp/$1/home" dbus-run-session -- sh -eu -c "$session" sh "$3" "/tmp/$1/mk"
	else
		HOME="/tmp/$1/home" sh -eu -c "$session" sh "$3" "/tmp/$1/mk"
	fi
}

state noSessionBus no-bus none
state noSecretService bus none
state noKeyring bus start
state unlocked bus unlock
# The unlocked state's keyring, now locked: unlocking it needs a prompt, and there is no display.
state locked bus start unlocked
