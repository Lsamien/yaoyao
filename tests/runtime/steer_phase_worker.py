"""Test-only barriers around the real worker; production has no timing/test switches."""
from pathlib import Path
import runpy
import sys
import threading

phase = sys.argv[1]
runtime = Path(__file__).resolve().parents[2] / 'runtime'
sys.path.insert(0, str(runtime))
main = runpy.run_path(str(runtime / 'worker.py'), run_name='steer_phase_test')['main']
worker = main.__globals__
emit = worker['emit']
acknowledged = threading.Event()
paused = False


def pause():
    global paused
    if paused:
        return
    paused = True
    emit('test.steer_phase', phase=phase)
    if not acknowledged.wait(10):
        raise RuntimeError('Steer phase barrier timed out: ' + phase)


def intercept_emit(kind, **payload):
    if kind == 'ready':
        import agent.conversation_loop as loop
        original_phase = loop._run_phase
        def run_phase(fn, agent, state, **kwargs):
            if phase == 'preparing' and fn.__name__ == 'announce_api_call':
                pause()
            result = original_phase(fn, agent, state, **kwargs)
            if phase == 'committed' and fn.__name__ == 'finish_text_response' and result.action == 'break':
                pause()
            return result
        loop._run_phase = run_phase
        if phase == 'settling':
            import agent.turn_finalizer as finalizer
            original_transform = finalizer.apply_llm_output_transform
            def transform(*args, **kwargs):
                result = original_transform(*args, **kwargs)
                pause()
                return result
            finalizer.apply_llm_output_transform = transform
        if phase == 'ready':
            pause()
    emit(kind, **payload)
    if kind == 'steer.result':
        acknowledged.set()


worker['emit'] = intercept_emit
if phase == 'initializing':
    original_read = worker['read_replies']
    def read_replies():
        emit('test.steer_phase', phase=phase)
        original_read()
    worker['read_replies'] = read_replies
    original_env = worker['load_hermes_env']
    def load_env(home):
        if not acknowledged.wait(10):
            raise RuntimeError('Startup steer was not acknowledged')
        original_env(home)
    worker['load_hermes_env'] = load_env
main()
