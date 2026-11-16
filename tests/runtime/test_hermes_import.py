"""Read-only import of an existing Hermes home into the embedded home."""
import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "runtime" / "hermes_import.py"


def tree_digest(root: Path) -> str:
    h = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file() and not p.name.endswith(("-wal", "-shm"))):
        h.update(str(path.relative_to(root)).encode())
        h.update(path.read_bytes())
    return h.hexdigest()


class HermesImportTest(unittest.TestCase):
    def test_copies_data_and_leaves_source_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, staging = Path(tmp, "hermes"), Path(tmp, "staging")
            (source / "profiles" / "writer").mkdir(parents=True)
            (source / "config.yaml").write_text("model:\n  provider: openrouter\n")
            (source / "auth.json").write_text('{"providers": {}}')
            (source / ".env").write_text("OPENROUTER_API_KEY=sk-test\n")
            (source / "profiles" / "writer" / "config.yaml").write_text("model:\n  default: x\n")
            (source / "skills" / "demo").mkdir(parents=True)
            (source / "skills" / "demo" / "SKILL.md").write_text("# demo\n")
            for skipped in ("hermes-agent", "logs", "plugins/yaoyao-bot-bridge"):
                (source / skipped).mkdir(parents=True)
                (source / skipped / "file.txt").write_text("skip")
            (source / "plugins" / "other").mkdir(parents=True)
            (source / "plugins" / "other" / "plugin.yaml").write_text("name: other\n")
            (source / "gateway.pid").write_text("123")
            db = sqlite3.connect(source / "state.db")
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)")
            db.execute("INSERT INTO sessions VALUES ('s1', 'hello')")
            db.commit()  # keep the connection open: the import must read a live WAL database
            before = tree_digest(source)

            result = subprocess.run([sys.executable, "-I", str(SCRIPT), str(source), str(staging)],
                                    capture_output=True, text=True, check=True)
            after = tree_digest(source)
            db.close()
            summary = json.loads(result.stdout)
            self.assertGreater(summary["files"], 0)

            self.assertEqual((staging / "config.yaml").read_text(), "model:\n  provider: openrouter\n")
            self.assertTrue((staging / "profiles" / "writer" / "config.yaml").exists())
            self.assertTrue((staging / "skills" / "demo" / "SKILL.md").exists())
            self.assertTrue((staging / "plugins" / "other" / "plugin.yaml").exists())
            for skipped in ("hermes-agent", "logs", "plugins/yaoyao-bot-bridge", "gateway.pid"):
                self.assertFalse((staging / skipped).exists(), skipped)
            copied = sqlite3.connect(staging / "state.db")
            self.assertEqual(copied.execute("SELECT title FROM sessions WHERE id='s1'").fetchone()[0], "hello")
            copied.close()
            manifest = json.loads((staging / ".import.json").read_text())
            self.assertEqual(manifest["source"], str(source.resolve()))
            self.assertEqual(oct((staging / ".env").stat().st_mode & 0o777), "0o600")
            # The legacy home is read-only input (WAL files from our own writer aside).
            self.assertEqual(after, before)

    def test_refuses_existing_staging_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, staging = Path(tmp, "hermes"), Path(tmp, "staging")
            source.mkdir()
            (source / "config.yaml").write_text("{}")
            staging.mkdir()
            result = subprocess.run([sys.executable, "-I", str(SCRIPT), str(source), str(staging)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
