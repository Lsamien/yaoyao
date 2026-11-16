"""Hermes provider/auth bridge: every op lands in Hermes-native config.yaml/.env/auth.json."""
import json
import os
import queue
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class Service:
    def __init__(self, home, root=None, extra_env=None):
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(home), "HERMES_HOME": str(home), "YAOVI_KERNEL": "1",
               "PYTHONUNBUFFERED": "1", "HERMES_SKIP_UPDATE_CHECK": "1",
               "YAOVI_HERMES_TEST_OFFLINE": "1", **(extra_env or {})}
        if root:
            env["YAOVI_HERMES_ROOT"] = str(root)
        self.proc = subprocess.Popen([sys.executable, str(ROOT / "runtime" / "hermes_service.py")], cwd=ROOT / "runtime",
                                     env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        assert json.loads(self.proc.stdout.readline())["type"] == "ready"
        self.n = 0

    def call(self, op, **args):
        self.n += 1
        self.proc.stdin.write(json.dumps({"id": str(self.n), "op": op, "args": args}) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)
        self.proc.stdout.close()


class HermesServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "hermes"
        self.bot = Path(self.tmp.name) / "bots" / "b1" / "runtime"
        self.root.mkdir(parents=True)
        self.bot.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_bot_home_reads_system_root_as_profile_parent(self):
        s = Service(self.bot, self.root)
        try:
            r = s.call("ping")
            self.assertEqual(Path(r["result"]["home"]).resolve(), self.bot.resolve())
            self.assertEqual(Path(r["result"]["root"]).resolve(), self.root.resolve())
        finally:
            s.close()

    def test_oauth_completion_preserves_the_selected_provider_and_model(self):
        code = '''
import sys
from pathlib import Path
sys.path[:0]=[str(Path.cwd()/"runtime"),str(Path.cwd()/"runtime/hermes")]
import hermes_service
hermes_service._bootstrap()
from hermes_cli.config import save_config,read_raw_config
from hermes_cli import anon_auth
for model in ({"provider":"openai-codex","default":"user-choice"},{"provider":"nous","default":"nous/welcome","base_url":"https://welcome.nousresearch.com/v1"}):
    save_config({"model":model})
    before=Path(__import__("os").environ["HERMES_HOME"],"config.yaml").read_bytes()
    result=anon_auth.settle_after_upgrade({"inference_base_url":"https://new-account.example/v1"})
    assert result=={"model":model["default"],"changed":False},result
    assert Path(__import__("os").environ["HERMES_HOME"],"config.yaml").read_bytes()==before
'''
        result = subprocess.run([sys.executable, "-c", code], cwd=ROOT,
                                env={"PATH": os.environ.get("PATH", ""), "HOME": str(self.root), "HERMES_HOME": str(self.root),
                                     "YAOVI_KERNEL": "1", "YAOVI_HERMES_TEST_OFFLINE": "1", "HERMES_SKIP_UPDATE_CHECK": "1"},
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])

    def test_nous_credential_save_preserves_active_provider_and_explicit_model_changes(self):
        code = '''
import json,os,sys
from pathlib import Path
from unittest.mock import patch
sys.path[:0]=[str(Path.cwd()/"runtime"),str(Path.cwd()/"runtime/hermes")]
import hermes_service
hermes_service._bootstrap()
from hermes_cli import auth,anon_auth
from hermes_cli.auth_nous import persist_nous_credentials
from hermes_cli.config import save_config,read_raw_config
home=Path(os.environ["HERMES_HOME"])
# Exercise the actual credential writer used by both the plain OAuth poller and
# guest promotion, including native pool reseeding. Only shared-store mirroring
# is isolated, so the test cannot reach a user-global credential file.
with patch("hermes_cli.auth._write_shared_nous_state"):
    for active in ("openai-codex","nous",None):
        original={"providers":{"openai-codex":{"access_token":"fixture-existing"}}}
        if active is not None: original["active_provider"]=active
        home.joinpath("auth.json").write_text(json.dumps(original))
        model={"provider":"auto","default":"user-choice","base_url":"https://chosen.example/v1"}
        save_config({"model":model})
        before=home.joinpath("config.yaml").read_bytes()
        persist_nous_credentials({"access_token":"fixture-new","token_type":"Bearer"},label="Connected apps")
        anon_auth.settle_after_upgrade({"inference_base_url":"https://new-account.example/v1"})
        stored=json.loads(home.joinpath("auth.json").read_text())
        assert stored.get("active_provider")==active,stored
        assert ("active_provider" in stored)==(active is not None),stored
        assert stored["providers"]["nous"]["access_token"]=="fixture-new"
        assert stored["providers"]["openai-codex"]["access_token"]=="fixture-existing"
        assert home.joinpath("config.yaml").read_bytes()==before
    # A user choosing a new default still updates both stores, and a later
    # credential save merges into that current state instead of restoring a stale one.
    save_config({"model":{"default":"vendor/old-model"}})
    auth._update_config_for_provider("openai-codex","",default_model="explicit-new-model")
    persist_nous_credentials({"access_token":"fixture-refreshed","token_type":"Bearer"})
    assert auth.get_active_provider()=="openai-codex"
    assert read_raw_config()["model"]["default"]=="explicit-new-model"
    assert read_raw_config()["model"]["provider"]=="openai-codex"
    save_config({"model":{"default":"vendor/old-model"}})
    auth._update_config_for_provider("nous","https://chosen.example/v1",default_model="explicit-nous-model")
    assert auth.get_active_provider()=="nous"
    assert read_raw_config()["model"]["default"]=="explicit-nous-model"
'''
        result = subprocess.run([sys.executable, "-c", code], cwd=ROOT,
                                env={"PATH": os.environ.get("PATH", ""), "HOME": str(self.root), "HERMES_HOME": str(self.root),
                                     "YAOVI_KERNEL": "1", "YAOVI_HERMES_TEST_OFFLINE": "1", "HERMES_SKIP_UPDATE_CHECK": "1"},
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])

    def test_config_patch_is_validated_and_hermes_native(self):
        s = Service(self.root)
        try:
            ok = s.call("config.patch", config={"model": {"provider": "deepseek", "default": "deepseek-chat"},
                                                "fallback_model": [{"provider": "openrouter", "model": "anthropic/claude-sonnet-4"}],
                                                "auxiliary": {"vision": {"provider": "auto", "model": ""}}})
            self.assertTrue(ok["ok"], ok)
            text = (self.root / "config.yaml").read_text()
            self.assertIn("deepseek-chat", text)
            self.assertIn("fallback_model", text)
            bad = s.call("config.patch", config={"fallback_model": "nope"})
            self.assertFalse(bad["ok"])
            self.assertEqual(bad["status"], 400)
            rejected = s.call("config.patch", config={"terminal": {}})
            self.assertEqual(rejected["status"], 400)
        finally:
            s.close()

    def test_persisted_config_reads_finish_while_auxiliary_request_is_still_running(self):
        entered, release = threading.Event(), threading.Event()

        class SlowModel(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                entered.set()
                release.wait(10)
                data = json.dumps({"choices": [{"message": {"content": "done"}, "finish_reason": "stop"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), SlowModel)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        s = Service(self.root)
        responses = queue.Queue()
        reader = None
        persisted = {"model": {"provider": "system", "default": "system-model"},
                     "custom_providers": [{"name": "system", "api_key": "fixture-system-secret", "base_url": "http://127.0.0.1:1/v1"}]}
        try:
            self.assertTrue(s.call("config.patch", config=persisted)["ok"])
            before = (self.root / "config.yaml").read_bytes()
            def read_responses():
                for line in s.proc.stdout:
                    responses.put(json.loads(line))
            reader = threading.Thread(target=read_responses, daemon=True)
            reader.start()
            def send(rid, op, **args):
                s.proc.stdin.write(json.dumps({"id": rid, "op": op, "args": args}) + "\n")
                s.proc.stdin.flush()
            overlay = {"model": {"provider": "slow", "default": "bot-model"},
                       "custom_providers": [{"name": "slow", "base_url": f"http://127.0.0.1:{server.server_port}/v1",
                                             "api_key": "fixture-bot-secret", "api_mode": "chat_completions"}]}
            send("slow", "aux.complete", prompt="synthetic request", config=overlay, timeout=5)
            self.assertTrue(entered.wait(5), "auxiliary request did not reach the gated model")
            for op in ("config.compiled", "config.get"):
                send(op, op)
                response = responses.get(timeout=2)
                self.assertEqual(response["id"], op)
                self.assertTrue(response["ok"], response)
                config = response["result"]["config"]
                self.assertEqual(config["model"], persisted["model"])
                self.assertNotIn("fixture-bot-secret", json.dumps(config))
                self.assertNotIn("bot-model", json.dumps(config))
                if op == "config.compiled":
                    self.assertEqual(config, persisted)
                else:
                    self.assertNotIn("fixture-system-secret", json.dumps(config))
            self.assertFalse(release.is_set())
            self.assertEqual((self.root / "config.yaml").read_bytes(), before)
            release.set()
            completed = responses.get(timeout=5)
            self.assertEqual(completed["id"], "slow")
            self.assertTrue(completed["ok"], completed)
            send("after", "config.compiled")
            self.assertEqual(responses.get(timeout=2)["result"]["config"], persisted)
        finally:
            release.set()
            s.close()
            if reader:
                reader.join(2)

    def test_credential_pool_is_plaintext_0600_and_redacted_on_wire(self):
        s = Service(self.root)
        try:
            added = s.call("pool.add", provider="deepseek", apiKey="sk-secret-abcdef123456", label="main")
            self.assertTrue(added["ok"], added)
            listed = s.call("pool.list", provider="deepseek")
            self.assertNotIn("sk-secret", json.dumps(listed))
            self.assertEqual(listed["result"]["entries"][0]["tokenPreview"], "…3456")
            auth = self.root / "auth.json"
            self.assertIn("sk-secret-abcdef123456", auth.read_text())
            self.assertEqual(stat.S_IMODE(auth.stat().st_mode), 0o600)
            self.assertTrue(s.call("pool.remove", provider="deepseek", index=1)["ok"])
            self.assertEqual(s.call("pool.list", provider="deepseek")["result"]["entries"], [])
        finally:
            s.close()

    def test_native_media_catalog_selection_and_key_validation(self):
        s = Service(self.root)
        try:
            for name, provider in (("image_gen", "OpenAI"), ("video_gen", "xAI Grok Imagine")):
                config = s.call("media.config", name=name)
                self.assertTrue(config["ok"], config)
                self.assertIn(provider, {p["name"] for p in config["result"]["providers"]})
                models = s.call("media.models", name=name, provider=provider)["result"]
                self.assertTrue(models["models"])
                model = models["models"][0]["id"]
                self.assertTrue(s.call("media.provider", name=name, provider=provider)["ok"])
                self.assertTrue(s.call("media.model", name=name, provider=provider, model=model)["ok"])
                raw = s.call("config.get")["result"]["config"]
                self.assertIn(model, (self.root / "config.yaml").read_text())
                self.assertEqual(raw[name]["provider"], "openai" if name == "image_gen" else "xai")
                self.assertEqual(raw[name]["model"], model)
                self.assertEqual(s.call("config.compiled")["result"]["config"][name], raw[name])
                self.assertEqual(s.call("media.model", name=name, provider=provider, model="not-a-model")["status"], 400)
            self.assertTrue(s.call("media.env", name="image_gen", env={"OPENAI_API_KEY": "sk-media-native-secret"})["ok"])
            self.assertIn("sk-media-native-secret", (self.root / ".env").read_text())
            self.assertNotIn("sk-media-native-secret", json.dumps(s.call("media.config", name="image_gen")))
            self.assertEqual(s.call("media.env", name="image_gen", env={"PATH": "nope"})["status"], 400)
            self.assertEqual(s.call("media.provider", name="video_gen", provider="OpenAI")["status"], 400)
        finally:
            s.close()

    def test_native_openai_image_dispatch_uses_media_settings_not_the_chat_model(self):
        import base64
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==")
        seen = []

        class Images(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((self.path, body, self.headers.get("Authorization")))
                data = json.dumps({"created": 1, "data": [{"b64_json": base64.b64encode(png).decode()}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Images)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        s = Service(self.root)
        try:
            self.assertTrue(s.call("env.set", key="OPENAI_API_KEY", value="native-image-key")["ok"])
            self.assertTrue(s.call("env.set", key="OPENAI_BASE_URL", value=f"http://127.0.0.1:{server.server_port}/v1")["ok"])
            self.assertTrue(s.call("media.provider", name="image_gen", provider="OpenAI")["ok"])
            models = s.call("media.models", name="image_gen", provider="OpenAI")["result"]
            chosen = models["models"][0]["id"]
            self.assertTrue(s.call("media.model", name="image_gen", provider="OpenAI", model=chosen)["ok"])
            result = s.call("media.generate", name="image_gen", arguments={"prompt": "a tree", "aspect_ratio": "square"})
            self.assertTrue(result["ok"], result)
            self.assertEqual(base64.b64decode(result["result"]["data"]), png)
            self.assertEqual(result["result"]["mimeType"], "image/png")
            self.assertEqual(seen[0][0], "/v1/images/generations")
            self.assertTrue(seen[0][1]["model"].startswith("gpt-image"))
            self.assertEqual(seen[0][2], "Bearer native-image-key")
        finally:
            s.close()

    def test_native_video_dispatch_downloads_the_completed_provider_job(self):
        import base64
        video = b"\x00\x00\x00\x18ftypmp42native-video-fixture"
        seen = []

        class Videos(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((self.path, body, self.headers.get("Authorization")))
                data = json.dumps({"id": "native-job", "status": "completed", "model": body["model"],
                                   "object": "video", "created_at": 1, "seconds": "5", "size": "1280x720"}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                seen.append((self.path, None, self.headers.get("Authorization")))
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(video)))
                self.end_headers()
                self.wfile.write(video)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Videos)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        s = Service(self.root)
        try:
            s.call("env.set", key="DEEPINFRA_API_KEY", value="native-video-key")
            s.call("env.set", key="DEEPINFRA_BASE_URL", value=f"http://127.0.0.1:{server.server_port}/v1")
            # Dynamic provider catalogs need the remote API; this offline fixture supplies its native config directly.
            self.assertTrue(s.call("config.patch", config={"video_gen": {"provider": "deepinfra", "model": "native-video"}})["ok"])
            result = s.call("media.generate", name="video_gen", arguments={"prompt": "a moving tree", "duration": 5})
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["result"]["mimeType"], "video/mp4")
            self.assertEqual(base64.b64decode(result["result"]["data"]), video)
            self.assertEqual(seen[0][0], "/v1/videos")
            self.assertEqual(seen[0][1]["model"], "native-video")
            self.assertEqual(seen[0][2], "Bearer native-video-key")
            self.assertEqual(seen[1][0], "/v1/videos/native-job/content")
        finally:
            s.close()

    def test_catalog_has_full_hermes_parity_and_oauth_external_is_refused(self):
        s = Service(self.root)
        try:
            ids = {p["id"] for p in s.call("providers.catalog")["result"]["providers"]}
            sys.path.insert(0, str(ROOT / "runtime" / "hermes"))
            from hermes_cli.providers import HERMES_OVERLAYS
            self.assertTrue(set(HERMES_OVERLAYS) <= ids, set(HERMES_OVERLAYS) - ids)
            oauth = {p["id"]: p for p in s.call("oauth.list")["result"]["providers"]}
            self.assertEqual(oauth["openai-codex"]["flow"], "device_code")
            refused = s.call("oauth.start", provider="anthropic")  # paste-token only, never in-app PKCE
            self.assertEqual(refused["status"], 400)
            offline = s.call("oauth.start", provider="qwen-oauth")  # remote OAuth unreachable in tests
            self.assertEqual(offline["status"], 502)
            self.assertEqual(s.call("nope")["status"], 404)
        finally:
            s.close()

    def test_env_keys_go_to_dotenv(self):
        s = Service(self.root)
        try:
            r = s.call("env.set", key="DEEPSEEK_API_KEY", value="sk-env-0987654321")
            self.assertTrue(r["ok"], r)
            self.assertIn("DEEPSEEK_API_KEY", (self.root / ".env").read_text())
            listed = s.call("env.list")["result"]
            self.assertTrue(listed["DEEPSEEK_API_KEY"]["is_set"])
            self.assertNotIn("sk-env-0987654321", json.dumps(listed))
        finally:
            s.close()


    def test_aux_complete_routes_task_slot_through_compiled_config(self):
        seen = []

        class Model(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append({"path": self.path, "model": body.get("model"), "auth": self.headers.get("Authorization")})
                data = json.dumps({"id": "x", "object": "chat.completion", "model": body.get("model"),
                                   "choices": [{"index": 0, "message": {"role": "assistant", "content": "标题：测试"}, "finish_reason": "stop"}],
                                   "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        endpoint = f"http://127.0.0.1:{server.server_port}/v1"
        s = Service(self.bot, self.root)
        try:
            config = {"model": {"provider": "main", "default": "main-model"},
                      "custom_providers": [{"name": "main", "base_url": endpoint, "api_key": "main-key", "api_mode": "chat_completions"},
                                           {"name": "cheap", "base_url": endpoint, "api_key": "cheap-key", "api_mode": "chat_completions"}],
                      "auxiliary": {"title_generation": {"provider": "cheap", "model": "cheap-model"}}}
            r = s.call("aux.complete", task="title_generation", prompt="起个标题", config=config)
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["result"]["text"], "标题：测试")
            self.assertEqual(seen[-1]["model"], "cheap-model")
            self.assertEqual(seen[-1]["auth"], "Bearer cheap-key")
            r = s.call("aux.complete", task="title_generation", prompt="synthetic observed title", config=config,
                       usageObservation={"rootRunId":"synthetic-root", "role":"auxiliary"})
            self.assertTrue(r["ok"], r)
            observed = r['result']['usageObservations']
            self.assertEqual([e['status'] for e in observed], ['started', 'completed'])
            self.assertEqual(observed[-1]['role'], 'auxiliary')
            self.assertEqual(observed[-1]['inputTokens'], 1)
            self.assertEqual(r['result']['text'], '标题：测试')
            r = s.call("aux.complete", task="compression", prompt="压缩", config=config)
            self.assertTrue(r["ok"], r)
            self.assertEqual(seen[-1]["model"], "main-model")
            self.assertNotIn('usageObservations', r['result'])
        finally:
            s.close()


if __name__ == "__main__":
    unittest.main()
