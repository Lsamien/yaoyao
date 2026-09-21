import base64, hashlib, json, os, pathlib, sys, tempfile, time, uuid, fcntl, stat

os.umask(0o077)

CHUNK = 512 * 1024
HARD = 100 * 1024 * 1024
namespace = sys.argv[1]
assert len(namespace) == 64 and all(c in '0123456789abcdef' for c in namespace), 'invalid namespace'
root = pathlib.Path(tempfile.gettempdir()) / ('.yaoyao-transfers-' + namespace)
root.mkdir(mode=0o700, exist_ok=True)
assert not root.is_symlink() and root.stat().st_uid == os.getuid(), 'invalid transfer directory'
action = json.load(sys.stdin)
lock = open(root / '.lock', 'a+')
fcntl.flock(lock, fcntl.LOCK_EX)

def save(path, value):
    temporary = str(path) + '.tmp'
    with open(temporary, 'w') as stream:
        json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)

def clean(path, state):
    temporary = state.get('temporary')
    if temporary:
        try: os.unlink(temporary)
        except FileNotFoundError: pass
    path.unlink(missing_ok=True)

def sha_file(path):
    sha = hashlib.sha256()
    with open(path, 'rb') as stream:
        while True:
            data = stream.read(CHUNK)
            if not data: break
            sha.update(data)
    return sha.hexdigest()

for old in root.glob('*.json'):
    try:
        state = json.loads(old.read_text())
        if state['expiresAt'] <= time.time() or action['op'] == 'transfer-cleanup': clean(old, state)
    except (ValueError, KeyError): pass

if action['op'] == 'transfer-cleanup':
    print(json.dumps({'ok': True})); sys.exit(0)

transfer_id = action['transferId']
assert str(uuid.UUID(transfer_id)) == transfer_id, 'invalid transfer id'
state_path = root / (transfer_id + '.json')
state = json.loads(state_path.read_text()) if state_path.exists() else None
op = action['op']

if op == 'transfer-abort':
    if state: clean(state_path, state)
    result = {'ok': True}
elif op in ('transfer-read-open', 'transfer-write-open'):
    limit = action['maxBytes']
    assert type(limit) is int and 1024 * 1024 <= limit <= HARD, 'invalid transfer limit'
    signature = json.dumps(action, sort_keys=True)
    if state:
        assert state['signature'] == signature, 'transfer id conflict'
        result = state['metadata']
    else:
        assert len(list(root.glob('*.json'))) < 64, 'too many transfers'
        path = pathlib.Path(action['path']).expanduser().absolute()
        assert '\x00' not in str(path), 'invalid file path'
        if op == 'transfer-read-open':
            temporary = root / (transfer_id + '.source')
            sha = hashlib.sha256(); size = 0
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            try:
                info = os.fstat(fd)
                assert stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'file exceeds transfer limit or is not a regular file'
                with os.fdopen(fd, 'rb', closefd=False) as source, open(temporary, 'xb') as target:
                    while True:
                        data = source.read(CHUNK)
                        if not data: break
                        size += len(data); assert size <= limit, 'file exceeds transfer limit'
                        sha.update(data); target.write(data)
            except BaseException:
                temporary.unlink(missing_ok=True); raise
            finally: os.close(fd)
            metadata = {'path': action['path'], 'size': size, 'sha256': sha.hexdigest()}
            state = {'kind': 'read', 'temporary': str(temporary), 'metadata': metadata}
        else:
            size = action['size']; sha = action['sha256']
            assert type(size) is int and 0 <= size <= limit, 'file exceeds transfer limit'
            assert len(sha) == 64 and all(c in '0123456789abcdef' for c in sha), 'invalid digest'
            assert type(action['overwrite']) is bool, 'invalid overwrite option'
            path.parent.mkdir(parents=True, exist_ok=True)
            path = path.parent.resolve() / path.name
            temporary = path.parent / ('.yaoyao-transfer-' + transfer_id)
            with open(temporary, 'xb'): pass
            metadata = {'path': action['path'], 'size': size, 'sha256': sha}
            state = {'kind': 'write', 'temporary': str(temporary), 'file': str(path), 'overwrite': action['overwrite'], 'received': 0, 'metadata': metadata}
        state.update(signature=signature, expiresAt=time.time() + 600)
        save(state_path, state); result = metadata
else:
    assert state, 'file transfer expired'
    metadata = state['metadata']
    if state['kind'] == 'committing':
        try:
            info = os.stat(state['file'], follow_symlinks=False)
            if info.st_ino == state['inode'] and info.st_dev == state['device'] and info.st_size == metadata['size'] and sha_file(state['file']) == metadata['sha256']:
                state['kind'] = 'complete'
        except FileNotFoundError: pass
    if op == 'transfer-status':
        result = dict(metadata, complete=state['kind'] == 'complete', received=state.get('received', 0))
    elif op == 'transfer-read':
        offset = action['offset']
        assert state['kind'] == 'read' and type(offset) is int and 0 <= offset <= metadata['size'], 'invalid read offset'
        length = min(CHUNK, metadata['size'] - offset)
        with open(state['temporary'], 'rb') as source: source.seek(offset); data = source.read(length)
        assert len(data) == length, 'incomplete source chunk'
        result = {'offset': offset, 'data': base64.b64encode(data).decode()}
    elif op == 'transfer-append':
        offset = action['offset']; encoded = action['data']
        assert state['kind'] == 'write' and type(offset) is int and offset >= 0, 'invalid write offset'
        assert type(encoded) is str and len(encoded) <= ((CHUNK + 2) // 3) * 4, 'chunk too large'
        data = base64.b64decode(encoded, validate=True)
        assert 0 < len(data) <= CHUNK and base64.b64encode(data).decode() == encoded and offset + len(data) <= metadata['size'], 'invalid chunk'
        with open(state['temporary'], 'r+b') as target:
            received = os.fstat(target.fileno()).st_size
            assert offset <= received, 'out of order chunk'
            target.seek(offset)
            if offset < received:
                assert target.read(len(data)) == data, 'conflicting repeated chunk'
            else: target.write(data); target.flush(); os.fsync(target.fileno())
            state['received'] = os.fstat(target.fileno()).st_size
        result = {'received': state['received']}
    elif op == 'transfer-finish':
        if state['kind'] != 'complete':
            assert state['kind'] == 'write' and state['received'] == metadata['size'], 'incomplete transfer'
            assert sha_file(state['temporary']) == metadata['sha256'], 'file digest mismatch'
            path = pathlib.Path(state['file'])
            assert path.parent.resolve() == path.parent, 'destination directory changed'
            info = os.stat(state['temporary']); state.update(kind='committing', inode=info.st_ino, device=info.st_dev)
            save(state_path, state)
            if state['overwrite']: os.replace(state['temporary'], path)
            else: os.link(state['temporary'], path)
            state['kind'] = 'complete'
            pathlib.Path(state['temporary']).unlink(missing_ok=True)
        result = dict(metadata, complete=True)
    else: raise ValueError('invalid transfer operation')
    state['expiresAt'] = time.time() + 600; save(state_path, state)
print(json.dumps(result))
