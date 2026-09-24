"""Exercise the production collector with disposable local process groups."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parents[3] / 'deploy' / 'computer'
sys.path.insert(0, str(DIRECTORY))
spec = importlib.util.spec_from_file_location('compose_bridge', DIRECTORY / 'compose_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def start_local(argv, cwd, user='cua'):
    return subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, start_new_session=True)


def request(path, body):
    data = json.dumps({'desktopId': 'test', 'token': 'token', 'instance': bridge.INSTANCE, **body}).encode()
    handler = object.__new__(bridge.Handler)
    handler.path = path
    handler.headers = {'Content-Length': str(len(data))}
    handler.rfile, handler.wfile = io.BytesIO(data), io.BytesIO()
    statuses = []
    handler.send_response = statuses.append
    handler.send_header = lambda *args: None
    handler.end_headers = lambda: None
    handler.do_POST()
    return statuses[0], json.loads(handler.wfile.getvalue())


class CommandChecks(unittest.TestCase):
    def test_cancel_stops_only_its_process_group_and_keeps_peer_and_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            ready, late, peer = [Path(directory) / name for name in ('ready', 'late', 'peer')]
            child = "import pathlib,time;time.sleep(.6);pathlib.Path(%r).write_text('late')" % str(late)
            script = "import pathlib,subprocess,sys,time;subprocess.Popen([sys.executable,'-c',%r]);pathlib.Path(%r).touch();time.sleep(30)" % (child, str(ready))
            peer_script = "import pathlib,time;time.sleep(.3);pathlib.Path(%r).write_text('ok')" % str(peer)
            lease = {'token': 'token', 'expires': time.monotonic() + 90, 'active': 0}
            key, results, started = str(uuid.uuid4()), {}, []
            def launch(argv, cwd, user='cua'):
                process = start_local(argv, directory)
                started.append(process)
                return process
            with patch.object(bridge, 'DESKTOP_ID', 'test'), patch.object(bridge, 'LEASE', lease), \
                    patch.object(bridge, 'start', side_effect=launch), patch.object(bridge, 'reset_desktop') as reset:
                threads = [threading.Thread(target=lambda: results.update(cancelled=request('/execute', {'operationId': key, 'argv': [sys.executable, '-c', script]}))),
                           threading.Thread(target=lambda: results.update(peer=request('/execute', {'operationId': str(uuid.uuid4()), 'argv': [sys.executable, '-c', peer_script]})))]
                try:
                    for thread in threads:
                        thread.start()
                    deadline = time.monotonic() + 3
                    while not ready.exists() and time.monotonic() < deadline:
                        time.sleep(.01)
                    self.assertTrue(ready.exists())
                    self.assertEqual(request('/cancel', {'operationId': key}), (200, {'ok': True, 'stopped': True, 'operationId': key}))
                    for thread in threads:
                        thread.join(3)
                        self.assertFalse(thread.is_alive())
                    self.assertEqual(results['cancelled'][0], 409)
                    self.assertEqual(results['peer'][0], 200)
                    self.assertEqual(peer.read_text(), 'ok')
                    time.sleep(.5)
                    self.assertFalse(late.exists(), 'cancel left a child running')
                    self.assertEqual(lease['active'], 0)
                    self.assertIs(bridge.LEASE, lease)
                    reset.assert_not_called()
                finally:
                    for process in started:
                        bridge.stop_command(process)
                    for thread in threads:
                        thread.join(3)

    def test_cancel_before_execute_prevents_late_launch_and_requires_the_current_lease(self):
        lease = {'token': 'token', 'expires': time.monotonic() + 90, 'active': 0}
        key = str(uuid.uuid4())
        with patch.object(bridge, 'DESKTOP_ID', 'test'), patch.object(bridge, 'LEASE', lease), patch.object(bridge, 'start') as launch:
            self.assertEqual(request('/cancel', {'operationId': key, 'token': 'wrong'})[0], 409)
            self.assertEqual(request('/cancel', {'operationId': key})[0], 200)
            self.assertEqual(request('/execute', {'operationId': key, 'argv': ['never-start']})[0], 409)
            self.assertEqual(request('/cancel', {'operationId': key})[0], 200)
            launch.assert_not_called()

    def test_timeout_does_not_restart_another_holders_desktop(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'should-not-exist'
            script = "import pathlib,time; time.sleep(.4); pathlib.Path(%r).write_text('late')" % str(marker)
            command = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',%r]); time.sleep(30)" % script
            # Keep one peer active; exercise the actual HTTP handler error path.
            lease = {'token': 'token', 'expires': time.monotonic() + 90, 'active': 1}
            body = json.dumps({'desktopId': 'test', 'token': 'token', 'instance': bridge.INSTANCE,
                               'argv': [sys.executable, '-c', command], 'timeout': 1000}).encode()
            handler = object.__new__(bridge.Handler)
            handler.path = '/execute'
            handler.headers = {'Content-Length': str(len(body))}
            handler.rfile = io.BytesIO(body)
            handler.wfile = io.BytesIO()
            statuses = []
            handler.send_response = statuses.append
            handler.send_header = lambda *args: None
            handler.end_headers = lambda: None
            # Make the timeout short enough to catch a surviving child before it writes.
            started = []
            def launch(argv, cwd, user='cua'):
                process = start_local(argv, directory)
                started.append(process)
                return process
            original = bridge.collect
            with patch.object(bridge, 'DESKTOP_ID', 'test'), patch.object(bridge, 'LEASE', lease), \
                    patch.object(bridge, 'start', side_effect=launch), \
                    patch.object(bridge, 'collect', side_effect=lambda p, data, timeout: original(p, data, .15)), \
                    patch.object(bridge, 'reset_desktop') as reset:
                try:
                    handler.do_POST()
                    self.assertEqual(statuses, [409])
                    reset.assert_not_called()
                    self.assertIs(bridge.LEASE, lease)
                    self.assertEqual(lease['active'], 1)
                    self.assertIsNotNone(started[0].poll())
                    time.sleep(.5)
                    self.assertFalse(marker.exists(), 'timed out command left a child process running')
                finally:
                    for process in started:
                        try:
                            os.killpg(process.pid, 9)
                        except ProcessLookupError:
                            pass
                        process.wait()

    def test_output_cap_is_enforced_while_the_process_is_still_writing(self):
        with patch.object(bridge, 'start', side_effect=start_local), patch.object(bridge, 'reset_desktop') as reset:
            before = time.monotonic()
            with self.assertRaisesRegex(ValueError, '输出超过限制'):
                bridge.run([sys.executable, '-c', "import os,time; os.write(1,b'x'*(9*1024*1024)); time.sleep(10)"], cwd='.', timeout=3)
            self.assertLess(time.monotonic() - before, 2)
            reset.assert_not_called()

    def test_large_input_and_both_output_streams_make_progress(self):
        with patch.object(bridge, 'start', side_effect=start_local):
            script = "import sys; sys.stdout.write('o'*200000); sys.stdout.flush(); sys.stderr.write('e'*200000); sys.stderr.flush(); data=sys.stdin.buffer.read(); print(len(data))"
            result = bridge.run([sys.executable, '-c', script], cwd='.', data=b'i' * 1000000, timeout=3)
            self.assertEqual(result['exitCode'], 0)
            self.assertEqual(result['stdout'], 'o' * 200000 + '1000000\n')
            self.assertEqual(result['stderr'], 'e' * 200000)


if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(CommandChecks))
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('COMPOSE_BRIDGE_CHECKS_OK')
