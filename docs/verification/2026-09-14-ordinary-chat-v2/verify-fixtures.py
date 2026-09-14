#!/usr/bin/env python3
"""Verify that TypeScript, Swift and Kotlin exercise the same v2 wire contract."""
import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[3]
source = json.loads((root / 'tests/fixtures/ordinary-chat-v2/protocol.json').read_text())
android = json.loads((root.parent / 'yaoyao-android/core/network/src/test/resources/ordinary-chat-v2/protocol.json').read_text())
ios_test = (root.parent / 'yaoyao-mobile/YaoYaoAITests/HermesHTTPRealtimeTests.swift').read_text()
match = re.search(r'fixtureJSON = #"""\s*(.*?)\s*"""#', ios_test, re.S)
assert match, 'iOS wire fixture is missing'
ios = json.loads(match.group(1))
assert source == android == ios, 'The three client fixtures have diverged'
canonical = json.dumps(source, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
print('Three-client fixture SHA-256:', hashlib.sha256(canonical).hexdigest())
