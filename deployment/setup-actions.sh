#!/usr/bin/env bash
# One-time root setup; invoke with the path to the deployment PUBLIC key.
set -euo pipefail
[[ $EUID == 0 && ( $# == 1 || $# == 2 ) ]] || { echo 'Usage: sudo bash setup-actions.sh /path/to/deploy-key.pub [--resume-before-links]'; exit 1; }
resume=false
if [[ $# == 2 ]]; then
    [[ $2 == --resume-before-links ]] || exit 1
    resume=true
fi
key=$(readlink -f "$1")
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
base=/opt/campus-wall/deploy
web=/var/www/campus-wall-deploy
override=/etc/systemd/system/campus-wall-backend.service.d/20-actions.conf
test -f "$key"
ssh-keygen -lf "$key"
grep -q '^ssh-ed25519 ' "$key"
[[ $(wc -l < "$key") -eq 1 ]]
if [[ $resume == false ]]; then
    test ! -e "$base"
    test ! -e "$web"
fi
test ! -e "$override"
test ! -e /etc/sudoers.d/campus-wall-deploy
test -f /opt/campus-wall/backend/.env
test -f /var/www/campus-wall/index.html
if command -v getenforce > /dev/null && [[ $(getenforce) == Enforcing ]]; then
    echo 'SELinux is enforcing; configure labels for the new release directories before setup.' >&2
    exit 1
fi
id campuswall > /dev/null
if [[ $resume == false ]] && id campusdeploy > /dev/null 2>&1; then
    echo 'campusdeploy already exists; inspect its configuration before running setup.' >&2
    exit 1
fi
for tool in python3 flock visudo curl nginx; do command -v "$tool" > /dev/null; done
test -x /usr/sbin/runuser
test -x /usr/pgsql-16/bin/pg_dump
test -x /usr/pgsql-16/bin/pg_restore
test -x /opt/nodejs/node-v22.23.2-linux-x64/bin/node
systemctl is-active --quiet campus-wall-backend
systemctl is-active --quiet nginx
nginx -t
grep -Eq '^[[:space:]]*root[[:space:]]+/var/www/campus-wall;' /etc/nginx/nginx.conf
curl --fail --silent --show-error --max-time 10 \
    --resolve campus-wall.me:443:127.0.0.1 https://campus-wall.me/ > /dev/null

# Resume only the known partial state that stopped before either link was created.
if [[ $resume == true ]]; then
    id -nG campusdeploy | tr ' ' '\n' | grep -Fxq campuswall
    for directory in "$base" "$base/backend" "$base/backend/releases" "$base/incoming" "$web" "$web/releases"; do
        test -d "$directory"
        test ! -L "$directory"
        [[ $(stat -c %U "$directory") == campusdeploy ]]
    done
    test -f "$base/shared/.env"
    [[ $(stat -c '%U:%G:%a' "$base/shared/.env") == root:campuswall:640 ]]
    { printf 'restrict '; cat "$key"; } | cmp - /home/campusdeploy/.ssh/authorized_keys
    for link in "$base/backend/current" "$web/current"; do
        test ! -e "$link"
        test ! -L "$link"
    done
fi
# The original parent can be campuswall:campuswall 700. Permit group traversal
# without granting group listing/write access or changing descendants.
[[ $(stat -c %G /opt/campus-wall) == campuswall ]] || { echo '/opt/campus-wall must belong to group campuswall; inspect permissions first.' >&2; exit 1; }
chmod g+x /opt/campus-wall
if [[ $resume == false ]]; then
    useradd --create-home --shell /bin/bash --groups campuswall campusdeploy
    install -d -o campusdeploy -g campusdeploy -m 700 /home/campusdeploy/.ssh
    { printf 'restrict '; cat "$key"; } > /home/campusdeploy/.ssh/authorized_keys
    chown campusdeploy:campusdeploy /home/campusdeploy/.ssh/authorized_keys
    chmod 600 /home/campusdeploy/.ssh/authorized_keys
    install -d -o campusdeploy -g campuswall -m 750 "$base" "$base/backend" "$base/backend/releases" "$base/incoming"
    install -d -o root -g campuswall -m 750 "$base/shared"
    install -o root -g campuswall -m 640 /opt/campus-wall/backend/.env "$base/shared/.env"
    install -d -o campusdeploy -g campusdeploy -m 755 "$web" "$web/releases"
fi
runuser -u campusdeploy -- test -x /opt/campus-wall
runuser -u campusdeploy -- ln -s /opt/campus-wall/backend "$base/backend/current"
runuser -u campusdeploy -- ln -s /var/www/campus-wall "$web/current"
install -o root -g root -m 755 "$scripts/campus-wall-deploy.sh" /usr/local/bin/campus-wall-deploy
install -o root -g root -m 755 "$scripts/campus-wall-backup.sh" /usr/local/sbin/campus-wall-backup
sudoers=$(mktemp)
trap 'rm -f -- "$sudoers"' EXIT
cat > "$sudoers" <<'SUDOERS'
campusdeploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart campus-wall-backend.service, /usr/local/sbin/campus-wall-backup ""
SUDOERS
visudo -cf "$sudoers"
install -o root -g root -m 440 "$sudoers" /etc/sudoers.d/campus-wall-deploy
# Validate backup access before changing the running application's configuration.
runuser -u campusdeploy -- sudo -n /usr/local/sbin/campus-wall-backup
runuser -u campuswall -- test -r "$base/shared/.env"
runuser -u campusdeploy -- test -r "$base/shared/.env"

backup="/etc/nginx/nginx.conf.before-actions-$(date -u +%Y%m%dT%H%M%S)"
cp -p /etc/nginx/nginx.conf "$backup"
restore() {
    result=$?
    trap - EXIT
    rm -f -- "$sudoers"
    if (( result != 0 )); then
        echo 'Activation failed; restoring the original service and Nginx configuration.' >&2
        cp -p "$backup" /etc/nginx/nginx.conf
        rm -f -- "$override"
        systemctl daemon-reload
        systemctl restart campus-wall-backend || true
        nginx -t && systemctl reload nginx || true
        echo 'Setup directories are retained for diagnosis; do not blindly rerun setup.' >&2
    fi
    exit "$result"
}
trap restore EXIT
install -d -m 755 /etc/systemd/system/campus-wall-backend.service.d
cat > "$override" <<'SERVICE'
[Service]
WorkingDirectory=/opt/campus-wall/deploy/backend/current
SERVICE
sed -i 's@root[[:space:]]\+/var/www/campus-wall;@root /var/www/campus-wall-deploy/current;@g' /etc/nginx/nginx.conf
nginx -t
systemctl daemon-reload
systemctl restart campus-wall-backend
systemctl reload nginx
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 --max-time 5 \
    http://127.0.0.1:3001/api/health
curl --fail --silent --show-error --max-time 10 \
    --resolve campus-wall.me:443:127.0.0.1 https://campus-wall.me/ > /dev/null
echo
echo "Setup complete. Nginx backup: $backup"
echo 'Original application directories are retained. Configure GitHub Secrets next.'
