"""Profile-owned skill storage. Called by the Runner, never by model dispatch.

The caller supplies the Profile and provenance. Package paths are relative,
publication is version checked, and host programs from skills are never run.
"""
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import time

MAX_FILE = 1024 * 1024
MAX_PACKAGE = 4 * MAX_FILE
MAX_FILES = 128
NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
REVISION = re.compile(r"[a-f0-9]{64}\Z")
EXCLUDED = {"node_modules", "venv", "__pycache__", "site-packages"}


class SkillError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def require(condition, code="skill_invalid", message="技能包格式或路径无效"):
    if not condition:
        raise SkillError(code, message)


def file_path(value):
    require(isinstance(value, str) and 0 < len(value) <= 512)
    path = PurePosixPath(value)
    require(not path.is_absolute() and str(path) == value and "\\" not in value)
    require(all(not part.startswith(".") and not re.search(r'[\x00-\x1f\x7f\\:*?"<>|]', part) and part not in EXCLUDED for part in path.parts))
    require(not value.lower().endswith((".pem", ".key", ".p12", ".pfx")))
    return path


def metadata(content):
    import yaml
    require(len(content.encode()) <= MAX_FILE)
    match = re.match(r"\A\ufeff?---\s*\n(.*?)\n---\s*(?:\n|$)", content, re.S)
    require(match is not None, message="SKILL.md 必须包含 YAML 元数据")
    try:
        meta = yaml.safe_load(match.group(1))
    except Exception:
        raise SkillError("skill_invalid", "技能元数据无法解析") from None
    require(isinstance(meta, dict))
    name, description = meta.get("name"), meta.get("description")
    require(isinstance(name, str) and NAME.fullmatch(name) is not None, message="技能名必须为小写字母、数字和连字符，最多 64 字符")
    require(isinstance(description, str) and 0 < len(description.strip()) <= 1024, message="请提供不超过 1024 字符的技能说明")
    return meta


def revision(files):
    # Identical to the guest installer; independent of JSON escaping/order.
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode() + b"\0" + hashlib.sha256(files[name]).digest())
    return digest.hexdigest()


def decode_package(encoded):
    require(isinstance(encoded, dict) and 0 < len(encoded) <= MAX_FILES)
    files = {}
    for name, data in encoded.items():
        file_path(name)
        require(isinstance(data, str) and len(data) <= (MAX_FILE * 4 // 3 + 4))
        try:
            files[name] = base64.b64decode(data, validate=True)
        except Exception:
            raise SkillError("skill_invalid", "技能文件编码无效") from None
        require(len(files[name]) <= MAX_FILE)
    require(sum(map(len, files.values())) <= MAX_PACKAGE and "SKILL.md" in files)
    try:
        meta = metadata(files["SKILL.md"].decode("utf-8"))
    except UnicodeError:
        raise SkillError("skill_invalid", "SKILL.md 必须使用 UTF-8") from None
    return files, meta


def read_package(directory):
    require(directory.is_dir() and not directory.is_symlink(), "skill_path_unsafe", "技能目录不能是符号链接")
    files = {}
    for root, dirs, names in os.walk(directory, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in EXCLUDED)
        require(not any((Path(root) / d).is_symlink() for d in dirs), "skill_path_unsafe", "技能包不能包含目录链接")
        for name in sorted(names):
            if name.startswith("."):
                continue
            path = Path(root) / name
            relative = path.relative_to(directory).as_posix()
            file_path(relative)
            # O_NOFOLLOW prevents a link substitution between scan and open.
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                require(stat.S_ISREG(info.st_mode) and info.st_size <= MAX_FILE, "skill_path_unsafe", "技能文件必须为限额内的普通文件")
                files[relative] = stream.read(MAX_FILE + 1)
            require(len(files) <= MAX_FILES and sum(map(len, files.values())) <= MAX_PACKAGE)
    require("SKILL.md" in files)
    metadata(files["SKILL.md"].decode("utf-8"))
    return files


def encode(files):
    return {name: base64.b64encode(data).decode() for name, data in files.items()}


def write_json(path, value):
    require(not path.is_symlink(), "skill_path_unsafe", "技能记录不能重定向")
    fd, temporary = tempfile.mkstemp(prefix=".record-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def safe_directory(path):
    # Profile root was canonicalized by the configuration reader. Reject all
    # redirects below it, including the internal journal/history directories.
    require(not path.is_symlink(), "skill_path_unsafe", "技能存储目录不能重定向")
    path.mkdir(exist_ok=True, mode=0o700)
    require(path.is_dir())
    return path


@contextlib.contextmanager
def locked(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "r+b") as stream:
        if os.name == "nt":
            import msvcrt
            stream.write(b"\0"); stream.flush(); stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


class ProfileSkills:
    def __init__(self, home, config, provenance, authorize=lambda: None):
        self.home = Path(home).resolve()
        self.config = config
        self.provenance = provenance
        self.authorize = authorize
        self.local = self.home / "skills"
        self.state = self.home / ".yaoyao-skills"

    def roots(self):
        roots = [self.local]
        configured = self.config.get("skills", {}).get("external_dirs", [])
        if isinstance(configured, str):
            configured = [configured]
        for value in configured if isinstance(configured, list) else []:
            if isinstance(value, str):
                path = Path(os.path.expandvars(os.path.expanduser(value)))
                roots.append((self.home / path).resolve())
        return list(dict.fromkeys(roots))

    def entries(self, include_disabled=False):
        disabled = self.config.get("skills", {}).get("disabled", [])
        seen = set()
        for source in self.roots():
            if not source.is_dir() or source.is_symlink():
                continue
            for root, dirs, names in os.walk(source, followlinks=False):
                dirs[:] = sorted(d for d in dirs if not d.startswith((".", "_")) and d not in EXCLUDED and not (Path(root) / d).is_symlink())
                if "SKILL.md" not in names:
                    continue
                dirs[:] = []  # Supporting resources are not standalone skills.
                skill = Path(root)
                try:
                    require(not (skill / "SKILL.md").is_symlink())
                    require((skill / "SKILL.md").stat().st_size <= MAX_FILE)
                    meta = metadata((skill / "SKILL.md").read_text(encoding="utf-8"))
                    name = meta["name"]
                    if name in seen:
                        continue
                    seen.add(name)
                    if not include_disabled and name in disabled:
                        continue
                    yield name, skill, meta
                except (SkillError, OSError, UnicodeError):
                    continue

    def find(self, name, include_disabled=False):
        require(isinstance(name, str) and NAME.fullmatch(name) is not None)
        return next((entry for entry in self.entries(include_disabled) if entry[0] == name), None)

    def summary(self, entry):
        name, path, meta = entry
        extra = meta.get("metadata", {})
        hermes = extra.get("hermes", {}) if isinstance(extra, dict) else {}
        platforms = meta.get("platforms", hermes.get("platforms", []) if isinstance(hermes, dict) else [])
        if isinstance(platforms, str):
            platforms = [platforms]
        if not isinstance(platforms, list):
            platforms = []
        return {"name": name, "description": meta["description"], "compatibility": str(meta.get("compatibility", ""))[:500],
                "platforms": platforms, "linuxCompatible": not platforms or "linux" in platforms,
                "managed": path == self.local / "bot-learned" / name}

    def bundle(self, name):
        entry = self.find(name)
        require(entry is not None, "skill_missing", "当前 Profile 没有启用此技能")
        files = read_package(entry[1])
        return {**self.summary(entry), "revision": revision(files), "files": encode(files)}

    def recover(self, name):
        target = self.local / "bot-learned" / name
        backup = self.state / (name + ".previous")
        pending = self.state / (name + ".pending.json")
        require(not pending.is_symlink() and not target.is_symlink() and not backup.is_symlink(), "skill_path_unsafe", "技能事务路径被修改")
        if pending.exists():
            transaction = json.loads(pending.read_text())
            if target.exists() and revision(read_package(target)) == transaction["revision"]:
                history = safe_directory(self.state / name)
                write_json(history / "history.json", transaction["records"])
            pending.unlink()
        if backup.exists():
            require(not backup.is_symlink() and not target.is_symlink(), "skill_path_unsafe", "技能事务路径被修改")
            if not target.exists():
                os.replace(backup, target)
            else:
                shutil.rmtree(backup)

    def publish(self, name, encoded, expected, validation, restore=None):
        require(isinstance(name, str) and NAME.fullmatch(name) is not None)
        require(expected is None or isinstance(expected, str) and REVISION.fullmatch(expected) is not None)
        require(isinstance(validation, str) and 1 <= len(validation.strip()) <= 4000, message="发布时必须说明验证方式与结果")
        approval = self.config.get("skills", {}).get("write_approval", False)
        require(str(approval).lower() not in ("true", "on", "yes", "1", "approve", "enabled"), "skill_write_disabled", "此 Profile 要求技能写入审核，请在本机 Profile 中发布")
        safe_directory(self.local); safe_directory(self.local / "bot-learned"); safe_directory(self.state)
        with locked(self.state / "publish.lock"):
            self.recover(name)
            existing = self.find(name, True)
            target = self.local / "bot-learned" / name
            require(existing is None or existing[1] == target, "skill_not_managed", "同名技能由用户或外部来源维护，请使用新名称")
            require(not target.is_symlink(), "skill_path_unsafe", "技能目标不能为链接")
            # Never adopt a pre-existing directory without our provenance.
            history = safe_directory(self.state / name)
            journal = history / "history.json"
            require(not journal.is_symlink())
            records = json.loads(journal.read_text()) if journal.exists() else []
            require(not target.exists() or bool(records), "skill_not_managed", "此技能没有 Bot 发布记录，不能自动接管")
            require(not records or records[-1].get("ownerKey") == self.provenance.get("ownerKey"), "skill_not_managed", "此技能由其他账号维护")
            before = read_package(target) if target.exists() else None
            current = revision(before) if before else None
            require(current == expected, "skill_revision_conflict", "技能已被更新，请重新读取后合并")
            if restore:
                require(REVISION.fullmatch(restore) is not None and any(item["revision"] == restore for item in records), "skill_revision_missing", "未找到可回退版本")
                snapshot = history / (restore + ".json")
                require(not snapshot.is_symlink())
                encoded = json.loads(snapshot.read_text())
            files, meta = decode_package(encoded)
            require(not restore or revision(files) == restore, "skill_revision_invalid", "历史版本校验失败")
            require(meta["name"] == name, message="技能名与 SKILL.md 不一致")
            # Keep it discoverable by a macOS Profile. The execution contract is
            # a requirement on the tool target, not on the host OS of the model.
            if not restore:
                import yaml
                meta.pop("platforms", None)
                if isinstance(meta.get("metadata"), dict) and isinstance(meta["metadata"].get("hermes"), dict):
                    meta["metadata"]["hermes"].pop("platforms", None)
                meta["compatibility"] = "Requires an assigned Linux virtual machine and computer_shell; dependencies must be installed inside that VM."
                content = files["SKILL.md"].decode("utf-8")
                body = re.sub(r"\A\ufeff?---\s*\n.*?\n---\s*(?:\n|$)", "", content, count=1, flags=re.S)
                note = "本技能在隔离 Linux 电脑执行。使用 computer_skill_view 获取虚拟机路径，通过 computer_shell 执行脚本；请勿在宿主机直接运行。输出和依赖安装在虚拟机工作目录。\n\n"
                if not body.startswith(note):
                    body = note + body
                files["SKILL.md"] = ("---\n" + yaml.safe_dump(meta, allow_unicode=True, sort_keys=False) + "---\n" + body).encode()
            require(len(files["SKILL.md"]) <= MAX_FILE and sum(map(len, files.values())) <= MAX_PACKAGE)
            new_revision = revision(files)
            if new_revision == current:
                return {"name": name, "revision": current, "unchanged": True}
            stage = Path(tempfile.mkdtemp(prefix=".publish-", dir=self.local / "bot-learned"))
            try:
                for relative, data in files.items():
                    path = stage / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
                    path.chmod(0o644)
                stage.chmod(0o755)
                if str(self.config.get("skills", {}).get("guard_agent_created", False)).lower() in ("true", "yes", "on", "1"):
                    try:
                        from tools.skills_guard import scan_skill, should_allow_install
                        allowed, _ = should_allow_install(scan_skill(stage, source="agent-created"))
                    except Exception:
                        raise SkillError("skill_scan_unavailable", "Profile 要求技能扫描，但扫描未能完成") from None
                    require(allowed is True, "skill_scan_blocked", "Profile 的技能扫描未通过，请检查草稿")
                self.authorize()  # Recheck after staging/scanning, before commit.
                latest = revision(read_package(target)) if target.exists() else None
                require(latest == current, "skill_revision_conflict", "技能在发布前被修改，请重新读取后合并")
                for version, package in [(current, before), (new_revision, files)]:
                    if version:
                        snapshot = history / (version + ".json")
                        require(not snapshot.is_symlink())
                        if not snapshot.exists():
                            write_json(snapshot, encode(package))
                records.append({"revision": new_revision, "previous": current, "at": int(time.time() * 1000),
                                "validation": validation, "restoredFrom": restore, **self.provenance})
                pending = self.state / (name + ".pending.json")
                write_json(pending, {"revision": new_revision, "records": records})
                # Keep the preceding package for recovery if the process dies
                # between the two renames. Readers never see partial files.
                if target.exists():
                    os.replace(target, self.state / (name + ".previous"))
                os.replace(stage, target)
                self.recover(name)
                for cache in (self.home / ".skills_prompt_snapshot.json",):
                    cache.unlink(missing_ok=True)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
            return {"name": name, "revision": new_revision, "previous": current, "published": True, "profileAvailable": True}

    def call(self, action, args):
        if self.state.exists():
            require(not self.state.is_symlink() and not self.local.is_symlink() and not (self.local / "bot-learned").is_symlink(), "skill_path_unsafe", "技能存储目录不能重定向")
            pending_names = {path.name.removesuffix(".pending.json") for path in self.state.glob("*.pending.json")}
            pending_names.update(path.name.removesuffix(".previous") for path in self.state.glob("*.previous"))
            if pending_names:
                with locked(self.state / "publish.lock"):
                    for name in pending_names:
                        require(NAME.fullmatch(name) is not None)
                        self.recover(name)
        if action == "list":
            values = [self.summary(entry) for entry in self.entries()]
            return {"skills": values[:1000], "truncated": len(values) > 1000}
        if action == "view":
            return self.bundle(args["name"])
        if action == "publish":
            return self.publish(args["name"], args["files"], args.get("expectedRevision"), args["validation"])
        if action == "restore":
            return self.publish(args["name"], None, args["expectedRevision"], args["validation"], args["revision"])
        if action == "history":
            entry = self.find(args["name"])
            require(entry is not None and entry[1] == self.local / "bot-learned" / args["name"], "skill_not_managed", "此技能没有 Bot 发布历史")
            path = self.state / args["name"] / "history.json"
            require(not path.is_symlink())
            return {"name": args["name"], "history": json.loads(path.read_text())[-50:]}
        raise SkillError("skill_invalid", "未知技能操作")
