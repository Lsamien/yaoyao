"""Fixed skill transfer operations; installation never executes package code."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile

MAX_FILE = 1024 * 1024
MAX_PACKAGE = 4 * MAX_FILE
MAX_FILES = 128
ROOT = Path('/opt/yaoyao-skills')


def path_name(value):
    if not isinstance(value, str) or len(value) > 512:
        raise ValueError('技能文件路径无效')
    path = PurePosixPath(value)
    if not value or path.is_absolute() or str(path) != value or any(part.startswith('.') or re.search(r'[\x00-\x1f\x7f\\:*?"<>|]', part) for part in path.parts):
        raise ValueError('技能文件必须使用包内相对路径')
    return value


def fingerprint(files):
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode() + b'\0' + hashlib.sha256(files[name]).digest())
    return digest.hexdigest()


def install(body):
    namespace, revision = body.get('namespace'), body.get('revision')
    if any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in (namespace, revision)):
        raise ValueError('技能版本无效')
    encoded = body.get('files')
    if not isinstance(encoded, dict) or not 0 < len(encoded) <= MAX_FILES:
        raise ValueError('技能文件数量超过限制')
    files = {}
    for name, data in encoded.items():
        path_name(name)
        if not isinstance(data, str) or len(data) > MAX_FILE * 4 // 3 + 4:
            raise ValueError('技能文件超过限制')
        files[name] = base64.b64decode(data, validate=True)
    if 'SKILL.md' not in files or sum(map(len, files.values())) > MAX_PACKAGE or any(len(data) > MAX_FILE for data in files.values()) or fingerprint(files) != revision:
        raise ValueError('技能包不完整或版本不匹配')
    # ROOT and all descendants are root-owned. The cua user cannot substitute
    # parents, change modes or overwrite a previously installed revision.
    for directory in (ROOT, ROOT / namespace):
        if directory.is_symlink():
            raise ValueError('技能存储路径不能重定向')
        directory.mkdir(exist_ok=True, mode=0o755)
        if directory.stat().st_uid != 0 or directory.stat().st_mode & 0o022:
            raise ValueError('技能目录权限无效')
    target = ROOT / namespace / revision
    if target.is_symlink():
        raise ValueError('技能版本路径不能重定向')
    if not target.exists():
        stage = Path(tempfile.mkdtemp(prefix='.install-', dir=target.parent))
        try:
            for name, data in files.items():
                path = stage / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                path.chmod(0o444)
            for root, dirs, _ in os.walk(stage):
                Path(root).chmod(0o555)
            os.replace(stage, target)
        finally:
            if stage.exists():
                for root, _, _ in os.walk(stage):
                    Path(root).chmod(0o755)
                shutil.rmtree(stage)
    return {'path': str(target), 'revision': revision}


def collect(directory):
    root = Path(directory)
    if not root.is_absolute() or root.is_symlink() or root.resolve() != root or not root.is_dir():
        raise ValueError('草稿必须是隔离环境中的真实绝对目录')
    files = {}
    for parent, dirs, names in os.walk(root, followlinks=False):
        if any((Path(parent) / name).is_symlink() for name in dirs):
            raise ValueError('技能草稿不能包含符号链接')
        for name in sorted(names):
            path = Path(parent) / name
            relative = path_name(path.relative_to(root).as_posix())
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
                    raise ValueError('技能文件必须为限额内的普通文件')
                files[relative] = stream.read(MAX_FILE + 1)
            if len(files) > MAX_FILES or sum(map(len, files.values())) > MAX_PACKAGE:
                raise ValueError('技能包超过限制')
    if 'SKILL.md' not in files:
        raise ValueError('草稿缺少 SKILL.md')
    return {'files': {name: base64.b64encode(data).decode() for name, data in files.items()}, 'revision': fingerprint(files)}


if __name__ == '__main__':
    if sys.argv[1] == 'install':
        result = install(json.load(sys.stdin))
    elif sys.argv[1] == 'collect':
        result = collect(sys.argv[2])
    else:
        raise ValueError('未知技能传输操作')
    print(json.dumps(result))
