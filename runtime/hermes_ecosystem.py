"""Read-only bundled catalogs. Explicit import is separate from skill discovery/admission."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
ROOT=Path(__file__).resolve().parent/'hermes'
EXCLUDED={'__pycache__','.git','.DS_Store','node_modules'}


def skill_bundle(source_path, expected=None):
    parts=source_path.split(':',1)
    if len(parts)!=2 or parts[0] not in ('builtin','optional'):raise ValueError('技能来源无效')
    base=ROOT/('skills' if parts[0]=='builtin' else 'optional-skills')
    relative=Path(parts[1])
    if relative.is_absolute() or any(p in ('..','.') or p.startswith('.') for p in relative.parts):raise ValueError('技能路径无效')
    directory=base/relative
    if not directory.is_dir() or not directory.resolve().is_relative_to(base.resolve()):raise ValueError('技能不存在')
    for p in [directory,*directory.parents]:
        if p==base:break
        if p.is_symlink():raise ValueError('技能目录不能包含符号链接')
    files={}
    for p in sorted(directory.rglob('*')):
        if any(part in EXCLUDED for part in p.relative_to(directory).parts):continue
        if p.is_symlink():raise ValueError('技能包不能包含符号链接')
        if p.is_file():
            if p.stat().st_size>1048576:raise ValueError('资源超过单文件 1 MiB 限制')
            files[p.relative_to(directory).as_posix()]=p.read_bytes()
    if 'SKILL.md' not in files or len(files)>101 or sum(map(len,files.values()))>4000000:raise ValueError('技能包超过资源限额或缺少 SKILL.md')
    fingerprint=hashlib.sha256(b''.join(k.encode()+b'\0'+hashlib.sha256(v).digest() for k,v in sorted(files.items()))).hexdigest()
    if expected and expected!=fingerprint:raise ValueError('源技能已更新，请刷新目录后导入')
    resources={};encodings={}
    content=files.pop('SKILL.md').decode('utf8')
    for name,data in files.items():
        try:resources[name]=data.decode('utf8')
        except UnicodeDecodeError:resources[name]=base64.b64encode(data).decode();encodings[name]='base64'
    if len(json.dumps(resources))+len(content)>3900000:raise ValueError('技能编码后超过包限额')
    from agent.skill_utils import parse_frontmatter
    meta,_=parse_frontmatter(content)
    return {'sourcePath':source_path,'fingerprint':fingerprint,'nativePath':relative.as_posix(),
            'name':str(meta.get('name') or directory.name),'description':str(meta.get('description') or directory.name),
            'content':content,'resources':resources,'resourceEncodings':encodings}


def skills_catalog():
    from agent.skill_utils import parse_frontmatter
    rows=[]
    for source,top in [('builtin','skills'),('optional','optional-skills')]:
        for p in sorted((ROOT/top).rglob('SKILL.md')):
            path=source+':'+p.parent.relative_to(ROOT/top).as_posix()
            meta,_=parse_frontmatter(p.read_text());missing=[]
            declared=meta.get('metadata',{});declared=declared if isinstance(declared,dict) else {}
            commands=meta.get('required_commands') or declared.get('commands') or []
            if isinstance(commands,list):missing=[str(c) for c in commands if isinstance(c,str) and not shutil.which(c)]
            env=meta.get('required_environment_variables') or [];creds=meta.get('required_credential_files') or []
            missing_env=[v for v in env if isinstance(v,str) and not os.environ.get(v)]
            from hermes_constants import get_hermes_home
            credential_root=Path(get_hermes_home())
            missing_creds=[]
            for value in creds:
                credential_path=value.get('path','') if isinstance(value,dict) else str(value)
                relative=Path(credential_path)
                if relative.is_absolute() or '..' in relative.parts or not (credential_root/relative).is_file():missing_creds.append(credential_path)
            platform={'darwin':'macos','win32':'windows'}.get(sys.platform,'linux')
            platforms=meta.get('platforms') or []
            unsupported=isinstance(platforms,list) and bool(platforms) and platform not in platforms

            row={'sourcePath':path,'source':source,'name':str(meta.get('name') or p.parent.name),
                 'description':str(meta.get('description') or p.parent.name),'missingCommands':missing,
                 'readiness':'unsupported' if unsupported else 'needs_setup' if missing or missing_env or missing_creds else 'not_checked','missingEnvironment':missing_env,'missingCredentials':missing_creds,'importable':True}
            try:
                b=skill_bundle(path);row.update({'fingerprint':b['fingerprint'],'fileCount':1+len(b['resources'])})
            except (ValueError,UnicodeError) as e:row.update({'importable':False,'reason':str(e)})
            rows.append(row)
    return {'skills':rows,'environment':'Host','note':'准备状态只检查声明项；导入不会自动安装依赖或授权。'}
