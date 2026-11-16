"""Embedded memory lifecycle: long-term memory lives in the Yaoyao workspace.

Authorized workspace knowledge remains in the control-plane prompt; Hermes keeps no
separate memory store or native memory provider in embedded workers.
"""
class WorkspaceMemoryStore:
    def load_from_disk(self):
        pass

    def format_for_system_prompt(self, target):
        return None  # the frozen workspace prompt contains this snapshot

    def reset_consolidation_failures(self):
        pass


def initialize(agent, config, skip_memory, platform='yaovi'):
    from agent.runtime_context import current
    if current() is None:
        return False
    memory = config.get("memory", {})
    enabled = memory.get("enabled", True) and not skip_memory
    agent._memory_store = WorkspaceMemoryStore() if enabled else None
    agent._memory_manager = None
    agent._memory_enabled = enabled
    agent._user_profile_enabled = enabled
    agent._memory_nudge_interval = 10 if memory.get("automatic", True) else 0
    agent._turns_since_memory = 0
    agent._iters_since_skill = 0
    return True
