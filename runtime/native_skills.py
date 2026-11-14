import base64
import sys
"""Run the bundled native skill tools against an admitted, isolated working copy.

Yaovi owns immutable versions and Bot authorization. All skill semantics (frontmatter,
batch edits, supporting files, read-before-write and learning) stay in the native tools.
Only a successful native change set is committed to the workspace.
"""
import json
from copy import deepcopy
import shutil
import tempfile
import threading
from pathlib import Path

_root = None
_entries = {}
_dispatch = None
_bot = None
_managed = False
_compact_index = False
_lock = threading.RLock()


def root():
    return _root


def compact_index_enabled():
    return _compact_index


def compact_description(text):
    """Bound only the discovery summary; the approved skill body stays intact."""
    return ' '.join(str(text or '').split()).encode('utf-16-le')[:320].decode('utf-16-le', errors='ignore')


def install(request, dispatch):
    global _root, _entries, _dispatch, _bot, _managed, _compact_index
    _dispatch, _bot = dispatch, request["botId"]
    _managed = request.get('botPolicy', {}).get('enabled') is True
    discovery = request.get('toolDiscovery') or {}
    _compact_index = discovery.get('version') == 1 and discovery.get('mode') == 'on_demand'
    parent = Path(request["dataRoot"]) / "skill-views"
    parent.mkdir(parents=True, exist_ok=True)
    _root = Path(tempfile.mkdtemp(prefix="run-", dir=parent)).resolve()
    _entries = {e["nativePath"]: dict(e) for e in request.get("skills", [])}
    restore()


def restore(entries=None, *, missing_only=False):
    # This is a disposable admission copy, never the authoritative skill library.
    if not missing_only:
        for p in _root.iterdir():
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            else:
                p.unlink()
    for path, entry in (entries if entries is not None else _entries).items():
        if not entry.get("enabled", True):
            continue
        for file, content in {"SKILL.md": entry["content"], **entry.get("resources", {})}.items():
            target = _root / path / file
            if target.is_absolute() and not target.resolve().is_relative_to(_root):
                raise ValueError("Invalid admitted skill path")
            if missing_only and target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(content,validate=True)) if entry.get('resourceEncodings',{}).get(file)=='base64' else target.write_text(content)


def load_missing(name, args, **kwargs):
    """Fetch approved frozen bundles without replacing this run's working copy."""
    if not _managed:
        return None
    # The control plane rechecks exactly the same operation fingerprint that
    # the registry guard admitted (including supporting-file/category options).
    request = {'action': 'list' if name == 'skills_list' else 'view', 'toolArgs': dict(args)}
    if name == 'skill_view' and isinstance(args.get('name'), str):
        request['name'] = args['name']
    ids = {key: kwargs[key] for key in ('tool_call_id', 'task_id', 'session_id') if kwargs.get(key) is not None}
    result = _dispatch('yaovi_skills_load', request, **ids)
    result = json.loads(result) if isinstance(result, str) else result
    if not isinstance(result, dict) or not isinstance(result.get('entries'), list):
        return json.dumps({'success': False, 'error': result.get('error', 'Skill loading was not authorized') if isinstance(result, dict) else 'Skill loading was not authorized'})
    additions = {}
    for entry in result['entries']:
        path = entry.get('nativePath') if isinstance(entry, dict) else None
        if not isinstance(path, str) or not path or not isinstance(entry.get('content'), str):
            return json.dumps({'success': False, 'error': 'Invalid admitted skill bundle'})
        known = _entries.get(path)
        if known and known['id'] != entry.get('id'):
            return json.dumps({'success': False, 'error': 'Skill identity changed; restart the task'})
        # A previously committed revision and local edits are authoritative for
        # this run. Lazy lookup must not put the initial snapshot back over them.
        if known and (_root / path).exists():
            continue
        additions[path] = known if known is not None else dict(entry)
    restore(additions, missing_only=True)
    _entries.update(additions)
    return None


def cleanup():
    if _root:
        shutil.rmtree(_root, ignore_errors=True)


def documents():
    from agent.skill_utils import parse_frontmatter
    result = {}
    for md in _root.rglob("SKILL.md"):
        rel = md.parent.relative_to(_root).as_posix()
        if any(part.startswith(".") for part in Path(rel).parts):
            continue
        content = md.read_text()
        meta, _ = parse_frontmatter(content)
        resources = {}
        encodings = {}
        for file in md.parent.rglob("*"):
            if file.is_symlink():
                raise ValueError("Skill resources cannot contain symbolic links")
            if file.is_file() and file != md:
                name=file.relative_to(md.parent).as_posix()
                if _entries.get(rel,{}).get('resourceEncodings',{}).get(name)=='base64':
                    resources[name]=base64.b64encode(file.read_bytes()).decode();encodings[name]='base64'
                else:
                    try: resources[name]=file.read_text()
                    except UnicodeDecodeError: resources[name]=base64.b64encode(file.read_bytes()).decode();encodings[name]='base64'
        result[rel] = {"nativePath": rel, "name": str(meta.get("name") or md.parent.name),
                       "description": str(meta.get("description") or md.parent.name),
                       "content": content, "resources": resources, "resourceEncodings": encodings}
    return result


def register(agent, writable=True):
    from tools import skills_tool, skill_manager_tool
    from tools.registry import registry
    skills_tool.SKILLS_DIR = skill_manager_tool.SKILLS_DIR = _root
    schemas = {"skills_list": skills_tool.SKILLS_LIST_SCHEMA, "skill_view": skills_tool.SKILL_VIEW_SCHEMA}
    if writable:
        schemas["skill_manage"] = skill_manager_tool.SKILL_MANAGE_SCHEMA

    def invoke(name, args, **kwargs):
        with _lock:
            # Revocation remains live even though the admitted content is frozen.
            admitted = json.loads(_dispatch("yaovi_skills_authorize", {}))
            if not isinstance(admitted, list):
                return json.dumps({"success": False, "error": admitted.get("error", "Skill access revoked")})
            allowed = set(admitted)
            for path, entry in _entries.items():
                if entry["id"] not in allowed and (_root / path).exists():
                    shutil.rmtree(_root / path)
            if name in ('skills_list', 'skill_view'):
                failure = load_missing(name, args, **kwargs)
                if failure is not None:
                    return failure
            skills_tool.clear_skills_cache()
            if name == "skills_list":
                result = skills_tool.skills_list(category=args.get("category"))
                if _compact_index:
                    parsed = json.loads(result)
                    def shorten(value):
                        if isinstance(value, dict):
                            return {key: compact_description(item) if key == 'description' and isinstance(item, str) else shorten(item) for key, item in value.items()}
                        return [shorten(item) for item in value] if isinstance(value, list) else value
                    return json.dumps(shorten(parsed), ensure_ascii=False)
                return result
            if name == "skill_view":
                if not skill_manager_tool._find_skill(args.get("name", "")):
                    return json.dumps({"success": False, "error": "Skill is not admitted for this Bot/session."})
                found=skill_manager_tool._find_skill(args.get("name", ""))
                resource=args.get('file_path')
                entry=_entries.get(found['path'].relative_to(_root).as_posix(),{}) if found else {}
                if resource and entry.get('resourceEncodings',{}).get(resource)=='base64':
                    return json.dumps({'success':True,'name':args['name'],'file_path':resource,'encoding':'binary','resource_root':str(found['path']),'note':'Binary resource preserved; transfer or read it using authorized file tools.'})
                result=skills_tool._skill_view_with_bump(args, **kwargs)
                parsed=json.loads(result)
                if found:
                    parsed['execution_context']={'resource_root':str(found['path']),'python':sys.executable,'environment':'Host','note':'Resolve scripts/templates relative to this frozen resource_root, not HERMES_HOME/skills. Transfer through authorized file tools before executing in another environment.'}
                return json.dumps(parsed,ensure_ascii=False)
            before = documents()
            try:
                # Existing skills may have localized display names. Resolve those
                # to their admitted stable path before native mutation validation.
                # Creation still uses the native filesystem-name rules.
                native_args = deepcopy(args)
                ops = native_args.get("operations") or [native_args]
                for op in ops:
                    found = skill_manager_tool._find_skill(op.get("name", native_args.get("name", "")))
                    if found:
                        key = found["path"].relative_to(_root).as_posix()
                        if _entries.get(key, {}).get("botId") != _bot:
                            return json.dumps({"success": False, "error": "Shared skills are read-only during tasks. Create a separate Bot skill or edit the shared skill in Yaovi settings."})
                        if op.get("action") != "create":
                            op["name"] = key
                result = skill_manager_tool._skill_manage_from(
                    native_args, task_id=kwargs.get("task_id"), session_id=kwargs.get("session_id"))
                parsed = json.loads(result)
                if not parsed.get("success") or parsed.get("staged"):
                    restore()
                    return result
                after = documents()
                changes = []
                for path in sorted(before.keys() | after.keys()):
                    if before.get(path) == after.get(path):
                        continue
                    old = _entries.get(path)
                    doc = after.get(path) or {**before[path], "content": None, "resources": {}}
                    changes.append({**doc, **({"id": old["id"]} if old else {}),
                                    "expectedRevision": old["revision"] if old else None})
                if changes:
                    committed = json.loads(_dispatch("yaovi_skills_commit", {"changes": changes}))
                    if committed.get("isError") or committed.get("error"):
                        restore()
                        return json.dumps({"success": False, "error": committed.get("error", "Skill commit failed")})
                    for entry in committed["entries"]:
                        path = entry["nativePath"]
                        _entries[path] = {**entry, **(after.get(path) or before[path])}
                    parsed["versions"] = [{"id": e["id"], "revision": e["revision"]} for e in committed["entries"]]
                return json.dumps(parsed, ensure_ascii=False)
            except Exception:
                restore()
                raise

    for name, schema in schemas.items():
        registry.register(name=name, toolset="skills", schema=schema,
                          handler=lambda args, _name=name, **kw: invoke(_name, args, **kw))
    agent.tools = [t for t in agent.tools if t["function"]["name"] not in (*schemas, "skill_read", "skill_propose", "skill_feedback", "skill_run_workflow")]
    agent.tools.extend({"type": "function", "function": schema} for schema in schemas.values())
