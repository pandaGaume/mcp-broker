import base64
import unittest

from mcp_provider import Provider, Multiplex
from mcp_provider.errors import RpcError


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.provider = Provider("catalog")

        @self.provider.resource("memory://json")
        def json_resource():
            return {"value": 42}

        @self.provider.resource("memory://bytes", mime_type="application/octet-stream")
        def binary():
            return b"\0\xff"

        @self.provider.resource("memory://device/{name}")
        async def device(name):
            return name

        @self.provider.prompt("diagnose")
        async def diagnose(machine: str, style: str = "brief"):
            return f"Diagnose {machine} ({style})"

        @self.provider.tool("async")
        async def async_tool(value: int):
            return value + 1

    def test_resources_and_templates(self):
        self.assertEqual(len(self.provider._dispatch("resources/list", {})["resources"]), 2)
        self.assertEqual(len(self.provider._dispatch("resources/templates/list", {})["resourceTemplates"]), 1)
        content = self.provider._dispatch("resources/read", {"uri": "memory://bytes"})["contents"][0]
        self.assertEqual(base64.b64decode(content["blob"]), b"\0\xff")
        content = self.provider._dispatch("resources/read", {"uri": "memory://device/pump%2012"})["contents"][0]
        self.assertEqual(content["text"], "pump 12")
        with self.assertRaises(RpcError) as caught:
            self.provider._dispatch("resources/read", {"uri": "memory://missing"})
        self.assertEqual(caught.exception.code, -32002)

    def test_subscriptions_and_notifications(self):
        self.provider._dispatch("resources/subscribe", {"uri": "memory://json"})
        self.provider.notify_resource_updated("memory://json")
        _, frame = self.provider._notifications.get_nowait()
        self.assertEqual(frame["params"], {"uri": "memory://json"})
        self.provider._dispatch("resources/unsubscribe", {"uri": "memory://json"})
        self.assertFalse(self.provider._subscriptions)

    def test_prompts_and_async_tools(self):
        listed = self.provider._dispatch("prompts/list", {})["prompts"]
        self.assertEqual(listed[0]["arguments"], [{"name": "machine", "required": True}, {"name": "style", "required": False}])
        result = self.provider._dispatch("prompts/get", {"name": "diagnose", "arguments": {"machine": "pump"}})
        self.assertEqual(result["messages"][0]["content"]["text"], "Diagnose pump (brief)")
        with self.assertRaises(RpcError):
            self.provider._dispatch("prompts/get", {"name": "diagnose", "arguments": {"machine": 42}})
        result = self.provider._dispatch("tools/call", {"name": "async", "arguments": {"value": 1}})
        self.assertEqual(result["structuredContent"], {"result": 2})

    def test_pagination(self):
        for i in range(103):
            self.provider.resource(f"memory://item/{i}")(lambda: "item")
        first = self.provider._dispatch("resources/list", {})
        self.assertEqual(len(first["resources"]), 100)
        second = self.provider._dispatch("resources/list", {"cursor": first["nextCursor"]})
        self.assertEqual(len(second["resources"]), 5)
        self.assertNotIn("nextCursor", second)
        with self.assertRaises(RpcError):
            self.provider._dispatch("resources/list", {"cursor": "bad"})

    def test_multiplex_ownership_and_tls_configuration(self):
        second = Provider("other")
        group = Multiplex([self.provider, second])
        group.connect("wss://localhost:3000", ca_file="ca.pem")
        self.assertTrue(group._tls)
        with self.assertRaises(RuntimeError):
            self.provider.connect()
        with self.assertRaises(ValueError):
            Multiplex([second])
        self.provider.stop()
        self.assertTrue(group._stop.is_set())
