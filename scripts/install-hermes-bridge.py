"""Install the bundled Hermes plugin; preserve disabled settings and keep a backup.

Run with the Hermes virtualenv Python. This command does not restart Hermes.
"""
import argparse
import json
import hashlib
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml


def fingerprint(directory):
    files = sorted(p for p in directory.rglob('*') if p.is_file() and '__pycache__' not in p.parts
                   and 'tests' not in p.relative_to(directory).parts and (p.suffix == '.py' or p.name in ('plugin.yaml', 'manifest.json')))
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(directory).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def check(root, profile, source):
    home = root if profile == 'default' else root / 'profiles' / profile
    result = {'profile': profile, 'exists': (home / 'config.yaml').is_file(), 'valid': False}
    if not result['exists'] or home.is_symlink() or (home / 'config.yaml').is_symlink():
        return result
    try:
        config = yaml.safe_load((home / 'config.yaml').read_bytes()) or {}
        plugins = config.get('plugins') or {}
        result.update(valid=True, enabled='yaoyao-bot-bridge' in plugins.get('enabled', []),
                      disabled='yaoyao-bot-bridge' in plugins.get('disabled', []))
        target = home / 'plugins' / 'yaoyao-bot-bridge'
        try:
            manifest = yaml.safe_load((target / 'plugin.yaml').read_bytes()) if (target / 'plugin.yaml').is_file() else {}
            result.update(installedVersion=str(manifest.get('version', '')) or None,
                          fingerprint=fingerprint(target) if manifest else None,
                          filesCurrent=bool(manifest) and fingerprint(target) == fingerprint(source))
        except Exception:
            result.update(installedVersion='未知', filesCurrent=False, message='插件文件损坏，可以重新安装修复')
    except Exception:
        result['message'] = '无法读取此 Profile 的插件配置'
    return result


def install(root, profile, source, enable=False):
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', profile):
        raise ValueError('Profile 名称无效')
    home = root if profile == 'default' else root / 'profiles' / profile
    config_path = home / 'config.yaml'
    if not config_path.is_file() or config_path.is_symlink() or home.is_symlink():
        raise ValueError('Profile 配置不存在或是符号链接')
    original = config_path.read_bytes()
    config = yaml.safe_load(original) or {}
    if not isinstance(config, dict):
        raise ValueError('Profile 配置格式无效')
    plugins = config.setdefault('plugins', {})
    if not isinstance(plugins, dict):
        raise ValueError('Profile 插件配置格式无效')
    for key in ('enabled', 'disabled'):
        if key in plugins and not isinstance(plugins[key], list):
            raise ValueError('Profile 插件列表格式无效')
    name = 'yaoyao-bot-bridge'
    if enable:
        plugins['disabled'] = [item for item in plugins.get('disabled', []) if item != name]
        # A dedicated Enable action changes this plugin's toolset only.
        agent = config.get('agent') or {}
        if isinstance(agent.get('disabled_toolsets'), list):
            agent['disabled_toolsets'] = [item for item in agent['disabled_toolsets'] if item != 'yaoyao_bot_bridge']
        platforms = config.get('platform_toolsets') or {}
        for platform in ('cli', 'tui'):
            if isinstance(platforms.get(platform), list) and 'all' not in platforms[platform] and 'yaoyao_bot_bridge' not in platforms[platform]:
                platforms[platform].append('yaoyao_bot_bridge')
    disabled = name in plugins.get('disabled', [])
    if not disabled and name not in plugins.setdefault('enabled', []):
        plugins['enabled'].append(name)
    directory = home / 'plugins'
    target = directory / name
    if directory.is_symlink() or target.is_symlink():
        raise ValueError('插件目录不能是符号链接')
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    backup = home / 'backups' / ('yaoyao-bridge-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'config.yaml').write_bytes(original)
    (backup / 'config.yaml').chmod(0o600)
    staged = directory / ('.yaoyao-bridge-' + uuid.uuid4().hex)
    previous = backup / name
    moved = False
    activated = False
    try:
        shutil.copytree(source, staged, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'tests'))
        if target.exists():
            target.rename(previous)
            moved = True
        staged.rename(target)
        activated = True
        fd, temporary = tempfile.mkstemp(prefix='.config-yaoyao-', dir=home)
        try:
            with os.fdopen(fd, 'w') as stream:
                yaml.safe_dump(config, stream, allow_unicode=True, sort_keys=False)
            os.replace(temporary, config_path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    except BaseException:
        if activated:
            shutil.rmtree(target)
        if moved:
            previous.rename(target)
        config_path.write_bytes(original)
        raise
    finally:
        if staged.exists():
            shutil.rmtree(staged)
    return {'profile': profile, 'installed': str(target), 'backup': str(backup), 'disabled': disabled,
            'message': '已更新，保留显式禁用设置' if disabled else '已更新并启用；空闲时重启 Hermes Dashboard 服务后生效'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hermes-home', required=True, type=Path)
    parser.add_argument('--profile', action='append', default=[])
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--enable', action='store_true', help='明确启用此插件及其工具集，保留其他禁用项')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent / 'hermes-bots-bridge'
    if not source.is_dir():
        source = Path(__file__).resolve().parents[1] / 'integrations' / 'hermes-bots-bridge'
    if not (source / 'plugin.yaml').is_file():
        raise ValueError('缺少随附的工具桥插件')
    root = args.hermes_home.expanduser().resolve()
    profiles = args.profile or (['default'] + sorted(p.name for p in (root / 'profiles').iterdir()
                 if p.is_dir() and not p.is_symlink() and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', p.name))
                 if args.check and (root / 'profiles').is_dir() else ['default'])
    for profile in dict.fromkeys(profiles):
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', profile):
            raise ValueError('Profile 名称无效')
        result = check(root, profile, source) if args.check else install(root, profile, source, enable=args.enable)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
