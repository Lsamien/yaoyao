"""Share exactly one runtime between Hermes' independent plugin loaders."""

import _imp
import importlib.util
import sys
from pathlib import Path


def runtime():
    # Hermes loads tool packages and dashboard APIs under unrelated module names.
    # Relative imports alone would give them independent authorization tables.
    name = "_yaoyao_bot_bridge_runtime_v1"
    _imp.acquire_lock()
    try:
        module = sys.modules.get(name)
        if module is None:
            spec = importlib.util.spec_from_file_location(
                name, Path(__file__).with_name("bridge_runtime.py")
            )
            if spec is None or spec.loader is None:
                raise ImportError("夭夭工具桥运行模块无法加载")
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            try:
                spec.loader.exec_module(module)
            except BaseException:
                sys.modules.pop(name, None)
                raise
        return module
    finally:
        _imp.release_lock()
