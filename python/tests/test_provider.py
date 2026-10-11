import gc
import json
import queue
import threading
import time
import unittest
from unittest.mock import patch

from mcp_provider import Provider
from mcp_provider._native import Transport


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.provider = Provider("test-slot")

        @self.provider.tool("echo")
        def echo(message: str, repetitions: int = 1):
            return {"message": message * repetitions}

        @self.provider.tool("fail")
        def fail():
            raise RuntimeError("expected failure")

        @self.provider.tool("nested")
        def nested(values: list[dict[str, int | None]]):
            return values

    def call(self, name, arguments):
        return self.provider._reply({"id": 1, "method": "tools/call",
                                     "params": {"name": name, "arguments": arguments}})

    def test_unicode_defaults_and_json(self):
        result = self.call("echo", {"message": 'été 🐍 "\\\n'})["result"]
        self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
        self.assertEqual(result["structuredContent"]["message"], 'été 🐍 "\\\n')

    def test_schema_and_argument_errors(self):
        tools = self.provider._dispatch("tools/list", {})["tools"]
        self.assertEqual(tools[0]["inputSchema"]["required"], ["message"])
        for name, args in [("missing", {}), ("echo", {}), ("echo", {"message": 3}),
                           ("echo", {"message": "x", "extra": 1}),
                           ("echo", {"message": "x", "repetitions": True}),
                           ("nested", {"values": [{"a": "bad"}]})]:
            self.assertEqual(self.call(name, args)["error"]["code"], -32602)
        self.assertIn("result", self.call("nested", {"values": [{"a": None, "b": 2}]}))

    def test_tool_exception(self):
        with self.assertLogs("mcp_provider.provider", level="ERROR"):
            result = self.call("fail", {})["result"]
        self.assertTrue(result["isError"])
        self.assertIn("expected failure", result["content"][0]["text"])

    def test_reject_invalid_configuration(self):
        for url in ["http://localhost", "ws://localhost/provider/test", "ws://x?token=y", "ws://u:p@x"]:
            with self.assertRaises(ValueError):
                self.provider.connect(url)
        for name in ["_all", "_broker", "", "a" * 64, "a\0b"]:
            with self.assertRaises(ValueError):
                Provider(name)
        with self.assertRaises(ValueError):
            Provider("test", secret="x\r\nOther: bad")

    def test_owned_native_handles(self):
        for _ in range(100):
            t = Transport("127.0.0.1", 1, "test", False, None, 4096, None)
            gc.collect()
            self.assertFalse(t.connected)
            self.assertEqual(t.generation, 0)
            t.close()
            t.close()

    def test_polling_queue_limit_and_reconnect_discards_late_reply(self):
        """A blocked tool must not block ping, overflow the queue or cross a reconnect."""
        provider = Provider("thread-test", max_pending=1)
        started, release = threading.Event(), threading.Event()

        @provider.tool("slow")
        def slow():
            started.set()
            release.wait(3)
            return "old result"

        class FakeTransport:
            def __init__(self):
                self.generation, self.connected = 1, True
                self.incoming, self.outgoing = queue.Queue(), queue.Queue()
                self.closed = False
                self.threads = set()

            def poll(self):
                self.threads.add(threading.get_ident())
                try:
                    frame = self.incoming.get(timeout=0.01)
                except queue.Empty:
                    return -2, None
                if frame == "reconnect":
                    self.generation += 1
                    return -2, None
                return 0, json.dumps(frame).encode()

            def send(self, data):
                self.threads.add(threading.get_ident())
                self.outgoing.put(json.loads(data))

            def close(self):
                self.threads.add(threading.get_ident())
                self.closed = True

        fake = FakeTransport()
        provider.connect("ws://localhost:3000")
        failures = []

        def run():
            try:
                provider.run()
            except BaseException as e:
                failures.append(e)

        with patch("mcp_provider.provider.Transport", return_value=fake):
            thread = threading.Thread(target=run)
            thread.start()
            try:
                fake.incoming.put({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "slow"}})
                self.assertTrue(started.wait(2))
                fake.incoming.put({"jsonrpc": "2.0", "id": 2, "method": "ping"})
                self.assertEqual(fake.outgoing.get(timeout=2), {"jsonrpc": "2.0", "id": 2, "result": {}})
                fake.incoming.put({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "slow"}})
                self.assertEqual(fake.outgoing.get(timeout=2)["error"]["code"], -32000)
                fake.incoming.put("reconnect")
                fake.incoming.put({"jsonrpc": "2.0", "id": 4, "method": "ping"})
                self.assertEqual(fake.outgoing.get(timeout=2)["id"], 4)
                release.set()
                time.sleep(0.05)
                fake.incoming.put({"jsonrpc": "2.0", "id": 5, "method": "ping"})
                self.assertEqual(fake.outgoing.get(timeout=2)["id"], 5)
                self.assertTrue(fake.outgoing.empty(), "Old result leaked into the new connection")
            finally:
                release.set()
                provider.stop()
                thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertTrue(fake.closed)
            self.assertEqual(fake.threads, {thread.ident})
            self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
