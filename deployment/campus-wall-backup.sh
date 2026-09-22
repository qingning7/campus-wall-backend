#!/usr/bin/env bash
# Root-owned helper. sudo permits this command without arguments only.
set -euo pipefail
[[ $EUID == 0 && $# == 0 ]] || exit 1
umask 077
backup_dir=/var/backups/campus-wall
install -d -m 700 "$backup_dir"
backup="$backup_dir/campus_wall-$(date -u +%Y%m%dT%H%M%S)-$$.dump"
trap 'rm -f -- "$backup.partial"' EXIT
/usr/sbin/runuser -u postgres -- /usr/pgsql-16/bin/pg_dump -Fc campus_wall > "$backup.partial"
test -s "$backup.partial"
/usr/pgsql-16/bin/pg_restore --list "$backup.partial" > /dev/null
mv -- "$backup.partial" "$backup"
echo "Database backup saved: $backup"
# Keep the ten newest completed dumps; never touch other files.
mapfile -t backups < <(find "$backup_dir" -maxdepth 1 -type f -name 'campus_wall-*.dump' -printf '%f\n' | sort -r)
for old in "${backups[@]:10}"; do
    rm -- "$backup_dir/$old"
done
