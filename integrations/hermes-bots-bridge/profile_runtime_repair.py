"""Prepare narrowly scoped repairs for Hermes' multi-Profile session routing.

The installer owns backup/activation/rollback. This module never writes files.
Unsupported source layouts fail before anything is changed.
"""
import ast
from pathlib import Path


def _function(source, name):
    matches = [node for node in ast.parse(source).body
               if isinstance(node, ast.FunctionDef) and node.name == name]
    if len(matches) != 1:
        raise ValueError(f'Hermes 接口 {name} 不兼容，未修改核心文件')
    node = matches[0]
    lines = source.splitlines(keepends=True)
    return node, ''.join(lines[node.lineno - 1:node.end_lineno])


def _replace_function(source, name, transform):
    node, body = _function(source, name)
    lines = source.splitlines(keepends=True)
    return ''.join(lines[:node.lineno - 1]) + transform(body) + ''.join(lines[node.end_lineno:])


def _config_first(body):
    marker = '# Yaoyao: each Profile owns its configured model.'
    if marker in body:
        return body
    old = '    if env := _env_model_seed():\n        return env\n    m = _load_cfg().get("model", "")\n'
    empty_model = '    if isinstance(m, dict):\n        return str(m.get("default", "") or "").strip()\n'
    anchor = '    # No env seed / config preference:'
    if body.count(old) != 1 or body.count(anchor) != 1 or body.count(empty_model) != 1:
        raise ValueError('Hermes 模型解析接口已改变，未修改核心文件')
    body = body.replace(old, f'    {marker}\n    m = _load_cfg().get("model", "")\n')
    body = body.replace(empty_model, '    if isinstance(m, dict):\n        m = str(m.get("default", "") or "").strip()\n')
    return body.replace(anchor, '    if env := _env_model_seed():\n        return env\n' + anchor)


def _provider_from_profile(body):
    marker = '# Yaoyao: launch-model/provider seeds cannot replace a configured Profile.'
    if marker in body:
        return body
    anchor = '    model = _resolve_model()\n'
    if body.count(anchor) != 1:
        raise ValueError('Hermes Provider 解析接口已改变，未修改核心文件')
    return body.replace(anchor, f'    {marker}\n'
                        '    configured_model, configured_provider = _config_model_target()\n'
                        '    if configured_model:\n'
                        '        return configured_model, configured_provider or None\n' + anchor)


def _scope_session_metadata(source):
    for method in ('session.create', 'session.resume'):
        needle = f'@method("{method}")\n'
        if source.count(needle) != 1:
            raise ValueError(f'Hermes {method} 接口已改变，未修改核心文件')
        if needle + '@_profile_scoped\n' not in source:
            source = source.replace(needle, needle + '@_profile_scoped\n')
    return source


def prepare(source_root: Path):
    """Return (path, original, replacement) tuples, including no-op entries."""
    files = [(source_root / 'tui_gateway' / 'server.py', lambda text:
              _replace_function(_replace_function(text, '_resolve_model', _config_first),
                                '_resolve_startup_runtime', _provider_from_profile)),
             (source_root / 'tui_gateway' / 'methods_session.py', _scope_session_metadata)]
    changes = []
    for path, transform in files:
        if not path.is_file() or path.is_symlink():
            raise ValueError('未找到可修复的 Hermes 核心文件')
        original = path.read_bytes()
        repaired = transform(original.decode('utf-8'))
        compile(repaired, str(path), 'exec')
        changes.append((path, original, repaired.encode('utf-8')))
    return changes
