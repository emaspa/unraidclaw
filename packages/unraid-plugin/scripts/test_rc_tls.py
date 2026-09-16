#!/usr/bin/env python3
"""Offline TLS tests using the real rc functions and temporary flash storage.

Host names and interface addresses are fixtures. The process launch is a shell
function that records startup, so no gateway, host config or network is used.
Certificates and private keys are generated only inside temporary directories.
"""

import hashlib
import os
from pathlib import Path
import shlex
import shutil
import ssl
import subprocess
import tempfile
import unittest


RC = Path(__file__).resolve().parents[1] / "rc.d/rc.unraidclaw"
OPENSSL = shutil.which("openssl")
BASH = shutil.which("bash")
HOSTNAME = "tls-test"
ADDRESSES = """5: br0    inet6 2001:db8::2/64 scope global
6: shim-br0    inet 192.0.2.10/24 brd 192.0.2.255 scope global shim-br0
4: docker0    inet 198.51.100.1/24 brd 198.51.100.255 scope global docker0
5: br0    inet 192.0.2.10/24 brd 192.0.2.255 scope global br0
6: shim-br0    inet6 2001:db8::2/64 scope global
5: br0    inet6 2001:db8::99/64 scope global temporary dynamic
5: br0    inet6 2001:db8::98/64 scope global deprecated dynamic
"""
EXPECTED_SAN = [
    f"DNS:{HOSTNAME}", f"DNS:{HOSTNAME}.local", "DNS:localhost",
    "IP Address:127.0.0.1", "IP Address:0:0:0:0:0:0:0:1",
    "IP Address:192.0.2.10", "IP Address:198.51.100.1",
    "IP Address:2001:DB8:0:0:0:0:0:2",
]


class RcTls(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(OPENSSL, "TLS tests require openssl")
        self.assertIsNotNone(BASH, "TLS tests require bash")
        self.temp = tempfile.TemporaryDirectory(prefix="unraidclaw-tls-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.tls = self.base / "flash/tls"
        self.tls.mkdir(parents=True)
        self.tools = self.base / "bin"
        self.tools.mkdir()
        # A closed PATH lets the missing-openssl case test an absent command.
        for name in ["awk", "cat", "chmod", "grep", "head", "mkdir", "mktemp",
                     "mv", "rm", "sort", "tr", "openssl"]:
            path = shutil.which(name)
            self.assertIsNotNone(path, f"TLS tests require {name}")
            (self.tools / name).symlink_to(path)
        self.write_tool("hostname", 'printf "%s\\n" "$TEST_HOSTNAME"\n')
        self.write_tool("ip", '[ "$*" = "-o addr show scope global" ] || exit 1\n'
                              'cat "$TEST_ROOT/addresses"\n')
        (self.base / "addresses").write_text(ADDRESSES)
        (self.base / "server").touch()
        self.env = {
            "PATH": str(self.tools), "LC_ALL": "C", "TEST_ROOT": str(self.base),
            "TEST_HOSTNAME": HOSTNAME,
        }

    def write_tool(self, name, body):
        path = self.tools / name
        path.unlink(missing_ok=True)
        path.write_text(f"#!{BASH}\n{body}")
        path.chmod(0o755)

    def openssl(self, *args):
        result = subprocess.run([OPENSSL, *map(str, args)], capture_output=True,
                                text=True, env={**os.environ, "LC_ALL": "C"})
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def seed_pair(self, san=None):
        args = ["req", "-x509", "-newkey", "ec", "-pkeyopt",
                "ec_paramgen_curve:prime256v1", "-nodes", "-days", "3650",
                "-subj", "/CN=unraidclaw", "-config", "/dev/null",
                "-keyout", self.tls / "key.pem", "-out", self.tls / "cert.pem"]
        if san:
            args += ["-addext", f"subjectAltName={san}"]
        self.openssl(*args)
        (self.tls / "key.pem").chmod(0o600)
        (self.tls / "cert.pem").chmod(0o644)
        return self.pair()

    def pair(self, suffix=""):
        # Compare every byte without exposing private keys in assertion output.
        return tuple(hashlib.sha256((self.tls / f"{name}.pem{suffix}").read_bytes()).hexdigest()
                     for name in ["cert", "key"])

    def start(self):
        # Source without running the command dispatcher. Redirect every path
        # before calling start(), and replace only the process launch.
        result = subprocess.run([BASH, "--noprofile", "--norc", "-c", r'''
source "$1"
FLASH_BASE="$TEST_ROOT/flash"
CONFIG="$FLASH_BASE/unraidclaw.cfg"
TLS_DIR="$FLASH_BASE/tls"
SERVER="$TEST_ROOT/server"
PIDFILE="$TEST_ROOT/pid"
LOGFILE="$TEST_ROOT/log"
VERSION_FILE="$TEST_ROOT/VERSION"
PLG_FILE="$TEST_ROOT/unraidclaw.plg"
NODE_BIN="$TEST_ROOT/fake-node"
nohup() {
  printf '%s\n' "$@" "$OCC_TLS_CERT" "$OCC_TLS_KEY" "$FLASH_BASE" > "$TEST_ROOT/started"
}
start
result=$?
wait
exit "$result"
''', "tls-test", str(RC)], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertIn("unraidclaw started (PID ", result.stdout)
        self.assertEqual((self.base / "started").read_text().splitlines(), [
            str(self.base / "fake-node"), str(self.base / "server"),
            str(self.tls / "cert.pem"), str(self.tls / "key.pem"),
            str(self.base / "flash"),
        ])
        self.assertFalse(list(self.tls.glob(".generate.*")))
        # The next call must exercise startup again, without a stale PID check.
        (self.base / "pid").unlink()
        (self.base / "started").unlink()
        return result.stdout

    def san(self):
        return self.openssl("x509", "-in", self.tls / "cert.pem", "-noout",
                            "-ext", "subjectAltName")

    def san_entries(self):
        return [entry.strip() for entry in self.san().split("\n", 1)[1].split(",")]

    def reject_generation(self, *, all_requests=False):
        rejection = 'if [ "$1" = req ]; then\n'
        rejection += '  for arg; do\n'
        rejection += '    if [ "$arg" = -addext ]; then\n'
        rejection += '      printf "san rejected\\n" >> "$TEST_ROOT/requests"\n'
        rejection += '      exit 1\n    fi\n  done\n'
        rejection += '  printf "legacy attempted\\n" >> "$TEST_ROOT/requests"\n'
        if all_requests:
            # Mimic a failed generator leaving partial output behind.
            rejection += '  while [ "$#" -gt 0 ]; do\n'
            rejection += '    case "$1" in\n'
            rejection += '      -out|-keyout) shift; printf "partial\\n" > "$1" ;;\n'
            rejection += '    esac\n    shift\n  done\n  exit 1\n'
        rejection += f'fi\nexec {shlex.quote(OPENSSL)} "$@"\n'
        self.write_tool("openssl", rejection)

    def assert_no_backups(self):
        self.assertFalse((self.tls / "cert.pem.bak").exists())
        self.assertFalse((self.tls / "key.pem.bak").exists())

    def test_fresh_install(self):
        self.tls.rmdir()
        output = self.start()
        self.assertIn("Generating self-signed TLS certificate...", output)
        self.assertEqual(self.san_entries(), EXPECTED_SAN)
        self.assertEqual(self.openssl("x509", "-in", self.tls / "cert.pem",
                                     "-noout", "-subject", "-nameopt", "RFC2253"),
                         f"subject=CN={HOSTNAME}")
        self.assertEqual((self.tls / "key.pem").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.tls / "cert.pem").stat().st_mode & 0o777, 0o644)
        details = self.openssl("x509", "-in", self.tls / "cert.pem", "-noout", "-text")
        self.assertIn("ASN1 OID: prime256v1", details)
        dates = self.openssl("x509", "-in", self.tls / "cert.pem", "-noout", "-dates")
        start, end = [ssl.cert_time_to_seconds(line.split("=", 1)[1])
                      for line in dates.splitlines()]
        self.assertEqual(end - start, 3650 * 24 * 60 * 60)
        self.openssl("verify", "-CAfile", self.tls / "cert.pem", "-verify_hostname",
                     HOSTNAME, self.tls / "cert.pem")
        self.openssl("verify", "-CAfile", self.tls / "cert.pem", "-verify_ip",
                     "192.0.2.10", self.tls / "cert.pem")
        self.openssl("verify", "-CAfile", self.tls / "cert.pem", "-verify_ip",
                     "2001:db8::2", self.tls / "cert.pem")
        self.assert_no_backups()
        print(f"\nGenerated certificate SAN:\n{self.san()}", flush=True)

    def test_legacy_pair_is_replaced_once_and_backed_up(self):
        old_pair = self.seed_pair()
        # Replacement overwrites older backups without touching them on restart.
        for name in ["cert", "key"]:
            (self.tls / f"{name}.pem.bak").write_bytes(b"previous backup\n")
        output = self.start()
        self.assertNotEqual(self.pair(), old_pair)
        self.assertEqual(self.pair(".bak"), old_pair)
        self.assertEqual(self.san_entries(), EXPECTED_SAN)
        self.assertEqual(output.count("Replaced TLS certificate;"), 1)
        self.assertIn(str(self.tls / "cert.pem.bak"), output)
        self.assertIn(str(self.tls / "key.pem.bak"), output)
        new_pair = self.pair()
        self.assertNotIn("Replaced TLS certificate;", self.start())
        self.assertEqual(self.pair(), new_pair)
        self.assertEqual(self.pair(".bak"), old_pair)

    def test_existing_san_is_unchanged_when_host_addresses_change(self):
        old_pair = self.seed_pair("DNS:custom.example")
        metadata = {p: p.stat().st_mtime_ns for p in self.tls.iterdir()}
        self.env["TEST_HOSTNAME"] = "renamed"
        (self.base / "addresses").write_text(
            "5: br0    inet 203.0.113.12/24 scope global br0\n")
        self.assertNotIn("Generating", self.start())
        self.assertEqual(self.pair(), old_pair)
        self.assertEqual({p: p.stat().st_mtime_ns for p in metadata}, metadata)
        self.assert_no_backups()

    def test_duplicate_addresses_have_a_stable_order(self):
        self.start()
        first = self.san_entries()
        self.assertEqual(len(first), len(set(first)))
        self.assertEqual(first, EXPECTED_SAN)
        for name in ["cert", "key"]:
            (self.tls / f"{name}.pem").unlink()
        (self.base / "addresses").write_text(
            "\n".join(reversed(ADDRESSES.splitlines())) + "\n")
        self.start()
        self.assertEqual(self.san_entries(), first)

    def test_rotating_ipv6_addresses_are_left_out(self):
        # A privacy address is replaced by the kernel on its own schedule, and
        # the certificate is never regenerated for an address change.
        self.start()
        entries = self.san_entries()
        self.assertNotIn("IP Address:2001:DB8:0:0:0:0:0:99", entries)
        self.assertNotIn("IP Address:2001:DB8:0:0:0:0:0:98", entries)
        self.assertIn("IP Address:2001:DB8:0:0:0:0:0:2", entries)

    def test_duplicate_localhost_name_appears_once(self):
        self.env["TEST_HOSTNAME"] = "localhost"
        self.start()
        self.assertEqual(self.san_entries().count("DNS:localhost"), 1)

    def test_addext_failure_keeps_existing_files(self):
        old_pair = self.seed_pair()
        self.reject_generation()
        self.start()
        self.assertEqual(self.pair(), old_pair)
        self.assertEqual((self.base / "requests").read_text(), "san rejected\n")
        self.assert_no_backups()

    def test_addext_failure_on_fresh_install_falls_back(self):
        self.reject_generation()
        self.start()
        for name in ["cert", "key"]:
            self.assertGreater((self.tls / f"{name}.pem").stat().st_size, 0)
        self.assertEqual(self.san(), "")
        self.assertEqual((self.base / "requests").read_text(),
                         "san rejected\nlegacy attempted\n")
        self.assert_no_backups()

    def test_total_generation_failure_still_starts(self):
        self.reject_generation(all_requests=True)
        self.start()
        self.assertFalse((self.tls / "cert.pem").exists())
        self.assertFalse((self.tls / "key.pem").exists())
        self.assertEqual((self.base / "requests").read_text(),
                         "san rejected\nlegacy attempted\n")
        self.assert_no_backups()

    def test_missing_openssl_still_starts_and_preserves_files(self):
        old_pair = self.seed_pair()
        (self.tools / "openssl").unlink()
        self.start()
        self.assertEqual(self.pair(), old_pair)
        self.assert_no_backups()

    def test_missing_openssl_on_fresh_install_still_starts(self):
        (self.tools / "openssl").unlink()
        self.start()
        self.assertEqual(list(self.tls.iterdir()), [])

    def test_missing_ip_command_still_includes_names_and_loopback(self):
        (self.tools / "ip").unlink()
        self.start()
        self.assertEqual(self.san_entries(), EXPECTED_SAN[:5])

    def test_backup_failure_preserves_existing_pair_and_still_starts(self):
        old_pair = self.seed_pair()
        # A directory at the backup path must not swallow the original key.
        (self.tls / "key.pem.bak").mkdir()
        self.assertNotIn("Replaced TLS certificate;", self.start())
        self.assertEqual(self.pair(), old_pair)
        self.assertEqual(list((self.tls / "key.pem.bak").iterdir()), [])

    def test_install_failure_restores_existing_pair_and_still_starts(self):
        old_pair = self.seed_pair()
        self.write_tool("mv", 'case "$2" in\n'
                              '  "$TEST_ROOT"/flash/tls/.generate.*/cert.pem) exit 1 ;;\n'
                              'esac\n'
                              f'exec {shlex.quote(shutil.which("mv"))} "$@"\n')
        self.assertNotIn("Replaced TLS certificate;", self.start())
        self.assertEqual(self.pair(), old_pair)

    def test_failed_san_inspection_replaces_legacy_pair(self):
        old_pair = self.seed_pair()
        self.write_tool("openssl", '[ "$1" != x509 ] || exit 1\n'
                                   f'exec {shlex.quote(OPENSSL)} "$@"\n')
        self.start()
        self.assertEqual(self.pair(".bak"), old_pair)
        self.assertEqual(self.san_entries(), EXPECTED_SAN)


if __name__ == "__main__":
    unittest.main(verbosity=2)
