#!/usr/bin/env python3
"""Offline archive regression tests. Pass the .txz produced by scripts/build.sh.

The manifest runs unchanged except for its downloaded package path. A local
upgradepkg stand-in runs GNU tar against a temporary root, never the host root.
The gzip cases replay rollback extraction with the same installer tar policy;
there is no production rollback script in this repository.
"""

import io
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import tempfile
import unittest
import xml.etree.ElementTree as ET


PACKAGE = Path(sys.argv.pop(1)).resolve()
MANIFEST = Path(__file__).resolve().parents[1] / "unraidclaw.plg"
RC = "etc/rc.d/rc.unraidclaw"
CLI = "usr/local/emhttp/plugins/unraidclaw/cli/unraidclaw.cjs"
WRAPPER = "usr/local/bin/unraidclaw"
SERVER = "usr/local/emhttp/plugins/unraidclaw/server/index.cjs"
VERSION_FILE = "usr/local/emhttp/plugins/unraidclaw/VERSION"
OLD_RC = b"#!/bin/sh\n# previous unraidclaw service\n"
SYSTEM_RC = b"#!/bin/sh\n# original system shutdown script\n"


class ArchiveSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="unraidclaw-archive-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "root"
        self.root.mkdir()
        self.tools = self.base / "bin"
        self.tools.mkdir()
        # Only this test double extracts. No services or package database touched.
        tool = self.tools / "upgradepkg"
        tool.write_text('#!/bin/bash\nset -euo pipefail\n'
                        '[[ "$#" == 2 && "$1" == --install-new ]]\n'
                        'tar "$TEST_TAR_MODE" "$2" -C "$TEST_ROOT"\n')
        tool.chmod(0o755)

    def fixture(self, links):
        for name in ["etc", "usr/local/etc/rc.d", "usr/local/emhttp", "usr/local/emhttp/plugin-store"]:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        rc = self.root / "etc/rc.d"
        plugins = self.root / "usr/local/emhttp/plugins"
        if links == "plain":
            rc.mkdir()
            plugins.mkdir()
        else:
            rc.symlink_to("../usr/local/etc/rc.d" if links == "relative"
                          else self.root / "usr/local/etc/rc.d", target_is_directory=True)
            plugins.symlink_to("plugin-store" if links == "relative"
                               else self.root / "usr/local/emhttp/plugin-store", target_is_directory=True)
        (plugins / "unraidclaw/server").mkdir(parents=True)
        (self.root / RC).write_bytes(OLD_RC)
        (rc / "rc.6").write_bytes(SYSTEM_RC)
        (rc / "rc.6").chmod(0o751)
        (rc / "rc.shutdown").symlink_to("rc.6")
        (rc / "unrelated").write_text("do not remove\n")
        # Deliberately unlike the 0755 archive directory headers.
        self.directories = {self.root, *(p for p in self.root.rglob("*") if p.is_dir())}
        for directory in self.directories:
            directory.chmod(0o750)
        self.metadata = {p: (p.stat().st_mode, p.stat().st_uid, p.stat().st_gid)
                         for p in self.directories}
        self.links = {p: (os.readlink(p), p.lstat().st_ino)
                      for p in [rc, plugins, rc / "rc.shutdown"] if p.is_symlink()}
        self.system_inode = (rc / "rc.6").stat().st_ino

    def assert_preserved(self):
        for path, (target, inode) in self.links.items():
            self.assertTrue(path.is_symlink(), f"directory/file symlink replaced: {path}")
            self.assertEqual(os.readlink(path), target)
            self.assertEqual(path.lstat().st_ino, inode)
        rc = self.root / "etc/rc.d"
        self.assertEqual((rc / "rc.6").read_bytes(), SYSTEM_RC)
        self.assertEqual((rc / "rc.6").stat().st_ino, self.system_inode)
        self.assertEqual((rc / "rc.6").stat().st_mode & 0o777, 0o751)
        self.assertEqual((rc / "rc.shutdown").read_bytes(), SYSTEM_RC)
        self.assertEqual((rc / "unrelated").read_text(), "do not remove\n")
        for path, metadata in self.metadata.items():
            self.assertEqual((path.stat().st_mode, path.stat().st_uid, path.stat().st_gid),
                             metadata, f"directory metadata changed: {path}")

    def run_installer(self, archive, mode="-xJf", *, allow_refusal=False):
        manifest = ET.parse(MANIFEST).getroot()
        download, = [f for f in manifest.findall("FILE")
                     if f.find("URL") is not None and f.attrib.get("Name", "").endswith(".txz")]
        env = {**os.environ, "PATH": f"{self.tools}:{os.environ['PATH']}",
               "TEST_ROOT": str(self.root), "TEST_TAR_MODE": mode, "LC_ALL": "C"}
        # Do not let a developer's TAR_OPTIONS hide an unsafe manifest.
        env.pop("TAR_OPTIONS", None)
        if "Run" in download.attrib:
            command = shlex.split(download.attrib["Run"]) + [str(archive)]
        else:
            script, = [f.findtext("INLINE") for f in manifest.findall("FILE")
                       if "upgradepkg --install-new" in (f.findtext("INLINE") or "")]
            command = ["bash", "-c", script.replace(download.attrib["Name"], str(archive))]
        result = subprocess.run(command, env=env, capture_output=True, text=True)
        if allow_refusal and result.returncode == 2 and "Invalid cross-device link" in result.stderr:
            # Some distro tar security patches reject legacy directory headers
            # crossing fixture symlinks. A safe refusal must still preserve the
            # host layout. Do not disable tar's safeguards to force success.
            print(f"\n  {archive.name}: tar safely refused fixture symlink traversal", file=sys.stderr)
            return False
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return True

    def repack(self, name, *, legacy=False, rollback=False):
        """Retain real payload headers; optionally recreate the old shared dirs."""
        path = self.base / name
        with tarfile.open(PACKAGE) as source, tarfile.open(
                path, "w:gz" if rollback else "w:xz") as target:
            directories = set()
            for member in source:
                if legacy:
                    parts = member.name.removeprefix("./").split("/")
                    # Match recursive tar ordering: directory headers precede
                    # their children, including ./etc/rc.d before the rc file.
                    for depth in range(len(parts)):
                        directory = "./" + "/".join(parts[:depth])
                        if directory not in directories:
                            directories.add(directory)
                            info = tarfile.TarInfo(directory.rstrip("/") + "/")
                            info.type = tarfile.DIRTYPE
                            info.mode = 0o755
                            info.uid, info.gid = os.getuid(), os.getgid()
                            target.addfile(info)
                    member.name = "./" + member.name.removeprefix("./")
                data = source.extractfile(member) if member.isfile() else None
                if rollback and member.name.removeprefix("./") == RC:
                    data = io.BytesIO(OLD_RC)
                    member.size = len(OLD_RC)
                target.addfile(member, data)
        return path

    def test_package_has_no_directory_headers(self):
        with tarfile.open(PACKAGE) as archive:
            members = archive.getmembers()
            self.assertFalse([m.name for m in members if m.isdir()],
                             "shared directory headers can replace host symlinks")
            by_name = {m.name.removeprefix("./"): m for m in members}
            self.assertIn(SERVER, by_name)
            self.assertIn(CLI, by_name)
            self.assertTrue(by_name[WRAPPER].mode & 0o111)
            self.assertTrue(by_name[RC].mode & 0o111)
            self.assertTrue(all(m.uid == 0 and m.gid == 0 for m in members))

    def test_package_records_its_own_version(self):
        # The service reports this version. It has to come from the package,
        # because the .plg on flash is saved only after the service restarted.
        version = PACKAGE.name.removeprefix("unraidclaw-").removesuffix("-x86_64-1.txz")
        self.assertNotEqual(version, PACKAGE.name, "package name does not follow the release pattern")
        with tarfile.open(PACKAGE) as archive:
            member = next((m for m in archive if m.name.removeprefix("./") == VERSION_FILE), None)
            self.assertIsNotNone(member, "package has no VERSION file")
            self.assertEqual(archive.extractfile(member).read(), f"{version}\n".encode())

    def test_install(self):
        self.fixture("relative")
        self.run_installer(PACKAGE)
        self.assert_preserved()
        with tarfile.open(PACKAGE) as archive:
            expected = next(archive.extractfile(m).read() for m in archive
                            if m.name.removeprefix("./") == RC)
        self.assertEqual((self.root / RC).read_bytes(), expected)
        self.assertTrue((self.root / SERVER).is_file())
        self.assertTrue((self.root / CLI).is_file())
        self.assertTrue((self.root / WRAPPER).stat().st_mode & 0o111)
        self.assertTrue((self.root / RC).stat().st_mode & 0o111)

    def test_fresh_install_through_directory_symlink(self):
        self.fixture("relative")
        (self.root / RC).unlink()
        self.run_installer(PACKAGE)
        self.assert_preserved()
        self.assertTrue((self.root / RC).is_file())
        self.assertTrue((self.root / SERVER).is_file())
        self.assertTrue((self.root / CLI).is_file())
        self.assertTrue((self.root / WRAPPER).stat().st_mode & 0o111)

    def test_new_package_survives_unprotected_direct_install(self):
        self.fixture("relative")
        env = dict(os.environ)
        env.pop("TAR_OPTIONS", None)
        subprocess.run(["tar", "-xJf", str(PACKAGE), "-C", str(self.root)],
                       env=env, check=True, capture_output=True)
        self.assert_preserved()
        self.assertNotEqual((self.root / RC).read_bytes(), OLD_RC)
        self.assertTrue((self.root / SERVER).is_file())
        self.assertTrue((self.root / CLI).is_file())
        self.assertTrue((self.root / WRAPPER).stat().st_mode & 0o111)

    def check_legacy_roundtrip(self, links):
        self.fixture(links)
        self.run_installer(self.repack("legacy.txz", legacy=True), allow_refusal=True)
        self.assert_preserved()
        # Replay tar -xzf rollback, with the policy exported by the manifest.
        restored = self.run_installer(self.repack("rollback.tar.gz", legacy=True, rollback=True),
                                      "-xzf", allow_refusal=True)
        self.assert_preserved()
        if restored:
            self.assertEqual((self.root / RC).read_bytes(), OLD_RC)

    def test_legacy_install_and_rollback_relative_symlinks(self):
        self.check_legacy_roundtrip("relative")

    def test_legacy_install_and_rollback_absolute_symlinks(self):
        self.check_legacy_roundtrip("absolute")

    def test_legacy_install_and_rollback_plain_directories(self):
        self.check_legacy_roundtrip("plain")

    def test_new_package_layout_survives_unprotected_gzip_rollback(self):
        self.fixture("relative")
        self.run_installer(PACKAGE)
        self.assert_preserved()
        env = dict(os.environ)
        env.pop("TAR_OPTIONS", None)
        subprocess.run(["tar", "-xzf", str(self.repack("rollback.tar.gz", rollback=True)),
                        "-C", str(self.root)], env=env, check=True, capture_output=True)
        self.assert_preserved()
        self.assertEqual((self.root / RC).read_bytes(), OLD_RC)


if __name__ == "__main__":
    unittest.main(verbosity=2)
