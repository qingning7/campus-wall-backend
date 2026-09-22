#!/usr/bin/env bash
# Installed by root; runs as campusdeploy, never as root.
set -euo pipefail
[[ $(id -un) == campusdeploy && $# == 2 ]] || { echo 'Run as campusdeploy: campus-wall-deploy backend|frontend RELEASE'; exit 1; }
component=$1
release_id=$2
[[ $component == backend || $component == frontend ]]
[[ $release_id =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]]
base=/opt/campus-wall/deploy
export PATH=/opt/nodejs/node-v22.23.2-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
umask 027
# Shared lock also serializes the two repositories on this server.
exec 9> "$base/deploy.lock"
flock -w 1200 9
archive="$base/incoming/$component-$release_id.tar.gz"
test -f "$archive"
if [[ $component == backend ]]; then
    root="$base/backend"
else
    root=/var/www/campus-wall-deploy
fi
test -L "$root/current"
previous=$(readlink -f "$root/current")
release="$root/releases/$release_id"
test ! -e "$release"
# Leave enough space for dependencies and a database dump.
available=$(df -Pk "$root" | awk 'NR==2 {print $4}')
(( available >= 2097152 )) || { echo 'Less than 2 GiB free; clean old releases/backups first.'; exit 1; }
mkdir "$release"
switched=false
healthy() {
    for attempt in {1..30}; do
        if curl --fail --silent --max-time 5 http://127.0.0.1:3001/api/health > /dev/null; then
            return 0
        fi
        sleep 1
    done
    return 1
}
switch_to() {
    ln -s "$1" "$root/.next-$release_id"
    mv -Tf "$root/.next-$release_id" "$root/current"
}
finish() {
    result=$?
    trap - EXIT
    if (( result != 0 )); then
        if [[ $switched == true ]]; then
            echo 'Deployment failed; restoring the previous code version.' >&2
            switch_to "$previous" || true
            if [[ $component == backend ]]; then
                sudo -n /usr/bin/systemctl restart campus-wall-backend.service || true
                healthy || echo 'Previous code is unhealthy; inspect service logs and database migration compatibility.' >&2
            fi
        fi
        echo 'Database migrations are NOT rolled back automatically. Inspect GitHub logs before retrying.' >&2
    fi
    rm -f -- "$archive"
    rm -f -- "$root/.next-$release_id"
    exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
# Reject traversal, links, devices and special files before extracting an artifact.
python3 - "$archive" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for entry in archive:
        path = PurePosixPath(entry.name)
        if path.is_absolute() or '..' in path.parts or not (entry.isfile() or entry.isdir()):
            raise SystemExit('Unsafe archive member: ' + entry.name)
        if any(p == '.env' or p.startswith('.env.') or p == '.git' for p in path.parts):
            raise SystemExit('Environment or Git metadata must not be packaged')
PY
tar --extract --gzip --file "$archive" --directory "$release" --no-same-owner --no-same-permissions
if [[ $component == backend ]]; then
    test -f "$release/package-lock.json"
    test -f "$release/src/server.ts"
    test -r "$base/shared/.env"
    ln -s "$base/shared/.env" "$release/.env"
    cd "$release"
    npm ci --include=dev --no-audit --no-fund
    npx --no-install prisma generate
    npx --no-install tsc --noEmit
    # npm can create files with stricter permissions: allow the runtime group to read.
    chgrp -R campuswall "$release"
    chmod -R g+rX,o-rwx "$release"
    sudo -n /usr/local/sbin/campus-wall-backup
    npx --no-install prisma migrate deploy
    switched=true
    switch_to "$release"
    sudo -n /usr/bin/systemctl restart campus-wall-backend.service
    healthy
else
    test -s "$release/index.html"
    if [[ -d "$release/assets" ]]; then
        find "$release/assets" -type f -printf '%P\n' > "$release/.current-assets"
    else
        : > "$release/.current-assets"
    fi
    # Keep the previous build's hashed assets for browsers still using its HTML.
    if [[ -d "$previous/assets" ]]; then
        mkdir -p "$release/assets"
        if [[ -f "$previous/.current-assets" ]]; then
            while IFS= read -r asset; do
                [[ $asset != /* && $asset != *..* ]]
                (cd "$previous/assets" && cp -an --parents -- "$asset" "$release/assets/")
            done < "$previous/.current-assets"
        else
            cp -an "$previous/assets/." "$release/assets/"
        fi
    fi
    chmod -R a+rX "$release"
    switched=true
    switch_to "$release"
    # Verify Nginx serves this exact index through the production HTTPS vhost.
    curl --fail --silent --show-error --max-time 15 \
        --resolve campus-wall.me:443:127.0.0.1 https://campus-wall.me/ | cmp - "$release/index.html"
fi
switched=false
echo "Deployed $component: $release_id"
# Retain current, previous, and up to three other releases. Never remove the original deployment.
mapfile -t versions < <(find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | awk '{print $2}')
retained=0
for version in "${versions[@]}"; do
    [[ $version =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || continue
    candidate="$root/releases/$version"
    [[ $candidate == "$release" || $candidate == "$previous" ]] && continue
    retained=$((retained + 1))
    if (( retained > 3 )); then
        rm -rf -- "$candidate"
    fi
done
