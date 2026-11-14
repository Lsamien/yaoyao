"""One-time, read-only import of an existing Hermes home into Yaoyao's embedded home.

Usage: python hermes_import.py SOURCE STAGING

SOURCE is never modified. SQLite databases are copied with the online backup API, so a
Hermes process that is still running is read as a consistent snapshot. Re-downloadable
runtimes, caches, logs, process files and Hermes' own installation are skipped. The
yaoyao-bot-bridge plugin is skipped: the embedded kernel has no plugin bridge.
Prints a JSON manifest on stdout.
"""
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

SKIP_DIRS = {"hermes-agent", "venv", ".venv", "node_modules", "models", "runtimes", "node", "logs",
             "cache", "__pycache__", ".git", "sandboxes", "tmp", "pm"}
SKIP_PLUGINS = {"yaoyao-bot-bridge"}
SKIP_SUFFIXES = (".pid", ".lock", ".sock", "-wal", "-shm", "-journal")
MAX_FILE = 512 * 1024 * 1024


def is_sqlite(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(16) == b"SQLite format 3\x00"
    except OSError:
        return False


def backup(source: Path, target: Path) -> None:
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=30)
    try:
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main(source: Path, staging: Path) -> dict:
    source = source.expanduser().resolve(strict=True)
    staging.mkdir(parents=True, exist_ok=False, mode=0o700)
    files, skipped = [], 0
    for root, dirs, names in os.walk(source, followlinks=False):
        current = Path(root)
        relative = current.relative_to(source)
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS
                   and not (relative.name == "plugins" and d in SKIP_PLUGINS)
                   and not (current / d).is_symlink()]
        (staging / relative).mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in names:
            path = current / name
            if name.endswith(SKIP_SUFFIXES) or path.is_symlink() or not path.is_file():
                skipped += 1
                continue
            if path.stat().st_size > MAX_FILE:
                skipped += 1
                continue
            target = staging / relative / name
            if is_sqlite(path):
                backup(path, target)
            else:
                shutil.copy2(path, target)
            os.chmod(target, 0o600)
            files.append({"path": str(relative / name), "sha256": digest(target)})
    version = None
    stamp = source / "hermes-agent" / "pyproject.toml"
    if stamp.exists():
        for line in stamp.read_text(errors="replace").splitlines():
            if line.strip().startswith("version"):
                version = line.split("=", 1)[1].strip().strip('"')
                break
    manifest = {"version": 1, "source": str(source), "importedAt": int(time.time() * 1000),
                "hermesVersion": version, "files": files, "skipped": skipped}
    (staging / ".import.json").write_text(json.dumps(manifest, ensure_ascii=False))
    os.chmod(staging / ".import.json", 0o600)
    return manifest


if __name__ == "__main__":
    result = main(Path(sys.argv[1]), Path(sys.argv[2]))
    print(json.dumps({"files": len(result["files"]), "skipped": result["skipped"], "hermesVersion": result["hermesVersion"]}))
