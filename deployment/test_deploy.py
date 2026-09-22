"""Linux deployment control-flow tests; all services/credentials are replaced by fixtures."""
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / "state"
        self.web = self.base / "web"
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for path in (self.state / "incoming", self.state / "shared",
                     self.state / "backend/releases", self.web / "releases"):
            path.mkdir(parents=True, exist_ok=True)
        (self.state / "shared/.env").write_text("TEST_ONLY=1\n")
        for root in (self.state / "backend", self.web):
            old = root / "original"
            old.mkdir()
            (old / "index.html").write_text("old")
            (root / "current").symlink_to(old)
        self.release_id = "a" * 40 + "-123-1"
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}")
        self.mock("id", 'echo campusdeploy')
        self.mock("npm", 'exit 0')
        self.mock("npx", '[ "${FAIL_STAGE:-}" != migration ] || [ "${2:-} ${3:-} ${4:-}" != "prisma migrate deploy" ]')
        self.mock("chgrp", 'exit 0')
        self.mock("sleep", 'exit 0')
        self.mock("df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 99999999 0 99999999 0%% /\\n"')
        self.mock("sudo", '[ "${FAIL_STAGE:-}" != backup ] || [ "$2" != /usr/local/sbin/campus-wall-backup ]')
        self.mock("curl", f'''
if [[ " $* " == *"https://campus-wall.me/"* ]]; then
    if [[ "${{FAIL_STAGE:-}}" == web ]]; then echo wrong-index; else cat "{self.web}/current/index.html"; fi
else
    [[ "${{FAIL_STAGE:-}}" != health ]]
fi
''')
        source = Path(__file__).with_name("campus-wall-deploy.sh").read_text()
        source = source.replace("/opt/campus-wall/deploy", str(self.state))
        source = source.replace("/var/www/campus-wall-deploy", str(self.web))
        source = source.replace("export PATH=", f"export PATH={self.bin}:")
        self.script = self.base / "deploy.sh"
        self.script.write_text(source)

    def mock(self, name, code):
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\nset -eu\n" + code + "\n")
        path.chmod(0o755)

    def run_deploy(self, component, fail="", unsafe=False):
        archive = self.state / "incoming" / f"{component}-{self.release_id}.tar.gz"
        files = {"index.html": "new", "assets/new.js": "new"} if component == "frontend" else {
            "package-lock.json": "{}", "src/server.ts": "// fixture"}
        if unsafe:
            files["../escape"] = "bad"
        with tarfile.open(archive, "w:gz") as tf:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data.encode()))
        return subprocess.run(["bash", str(self.script), component, self.release_id],
                              env=dict(self.env, FAIL_STAGE=fail), capture_output=True, text=True)

    def assert_old(self, component):
        root = self.web if component == "frontend" else self.state / "backend"
        self.assertEqual((root / "current").resolve(), root / "original")

    def test_frontend_switch(self):
        result = self.run_deploy("frontend")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.web / "current/index.html").read_text(), "new")

    def test_frontend_failure_restores_previous(self):
        result = self.run_deploy("frontend", "web")
        self.assertNotEqual(result.returncode, 0)
        self.assert_old("frontend")

    def test_unsafe_archive_does_not_switch(self):
        result = self.run_deploy("frontend", unsafe=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.web / "releases/escape").exists())
        self.assert_old("frontend")

    def test_backend_switch_preserves_shared_environment(self):
        result = self.run_deploy("backend")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.state / "backend/current/.env").resolve(), self.state / "shared/.env")

    def test_backup_failure_does_not_switch(self):
        self.assertNotEqual(self.run_deploy("backend", "backup").returncode, 0)
        self.assert_old("backend")

    def test_migration_failure_does_not_switch(self):
        self.assertNotEqual(self.run_deploy("backend", "migration").returncode, 0)
        self.assert_old("backend")

    def test_unhealthy_backend_restores_previous(self):
        self.assertNotEqual(self.run_deploy("backend", "health").returncode, 0)
        self.assert_old("backend")


if __name__ == "__main__":
    unittest.main()
