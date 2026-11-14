"""Real native-tool probe for editedSkills.test.ts; all state is in its temporary home."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'runtime'), str(ROOT / 'runtime/hermes')]
import native_skills
from agent import runtime_context
from tools.registry import registry

payload = json.loads(Path(sys.argv[1]).read_text())
entries = payload['old']
changes = []


def dispatch(name, args, **metadata):
    if name == 'yaovi_skills_authorize':
        return json.dumps([e['id'] for e in entries])
    if name == 'yaovi_skills_load':
        return json.dumps({'entries': entries})
    if name == 'yaovi_skills_commit':
        changes.extend(args['changes'])
        return json.dumps({'entries': [{**e, 'revision': 'probe-next'} for e in entries]})
    raise AssertionError(name)


def install(bundles):
    global entries
    entries = bundles
    native_skills.cleanup()
    runtime_context._context = None
    runtime_context.install({'botId': payload['botId'], 'dataRoot': str(Path(sys.argv[1]).parent),
                             'skills': bundles, 'tools': [], 'config': {'delegation': {'enabled': False}}}, dispatch)
    runtime_context.load_tools(SimpleNamespace(tools=[], platform='yaovi'))


def call(tool, args):
    return json.loads(registry.get_entry(tool).handler(args, task_id='test', session_id='session'))


try:
    install(payload['old'])
    result = {'old': call('skill_view', {'name': payload['old'][0]['name']})}
    install(payload['current'])
    name = entries[0]['name']
    result.update(list=call('skills_list', {}), view=call('skill_view', {'name': name}),
                  file=call('skill_view', {'name': name, 'file_path': 'references/proof.txt'}))
    result['patch'] = call('skill_manage', {'operations': [{'action': 'patch', 'name': name,
                            'old_string': 'Read original evidence.', 'new_string': 'Read updated evidence.'}]})
    result['changes'] = changes
    print(json.dumps(result))
finally:
    native_skills.cleanup()
