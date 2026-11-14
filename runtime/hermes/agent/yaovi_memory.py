"""Embedded memory lifecycle: workspace documents in user mode, native provider in peer mode.

Authorized workspace shared knowledge remains in the control-plane prompt. The
native OpenViking provider owns private peer capture, recall and session commits.
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
    identity = current().get("nativeMemory")
    if enabled and identity:
        agent._memory_nudge_interval = 0
        from agent.memory_manager import MemoryManager, inject_memory_provider_tools
        from agent.agent_init import _memory_provider_init_kwargs
        from native_openviking import YaoviOpenVikingProvider
        manager = MemoryManager()
        provider = YaoviOpenVikingProvider(identity, automatic=memory.get("automatic", True), recall=memory.get("recall", True))
        manager.add_provider(provider)
        kwargs = _memory_provider_init_kwargs(agent, platform)
        if current().get("review"):
            kwargs["agent_context"] = "flush"
        manager.initialize_all(**kwargs)
        agent._memory_manager = manager
        inject_memory_provider_tools(agent)
    return True
