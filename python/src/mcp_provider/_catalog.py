"""MCP resources, URI templates and prompt handlers, independent of transport."""
import asyncio
import base64
import inspect
import json
import queue
import re
from urllib.parse import unquote

from .errors import RpcError


def invoke(fn, **arguments):
    result = fn(**arguments)
    return asyncio.run(result) if inspect.isawaitable(result) else result


class Catalog:
    def _init_catalog(self):
        self._resources = {}
        self._templates = []
        self._prompts = {}
        self._subscriptions = set()
        self._notifications = queue.Queue(maxsize=1024)
        self._generation = 0
        self._group = None

    def _registration_allowed(self):
        if self._connection is not None or self._group is not None:
            raise RuntimeError("Register handlers before connect()")

    def resource(self, uri, *, name=None, description=None, mime_type=None):
        """Register a URI or a template with simple {parameter} expansions."""
        if not isinstance(uri, str) or not uri or "\0" in uri:
            raise ValueError("Resource URI must be a nonempty string")
        def register(fn):
            self._registration_allowed()
            variables = re.findall(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", uri)
            stripped = re.sub(r"\{[A-Za-z_][A-Za-z0-9_]*\}", "", uri)
            if "{" in stripped or "}" in stripped or len(set(variables)) != len(variables):
                raise ValueError("Use distinct simple {parameter} URI template expansions")
            signature = inspect.signature(fn)
            try:
                signature.bind(**{v: "value" for v in variables})
            except TypeError as e:
                raise ValueError("Resource handler parameters must match URI variables") from e
            metadata = {"name": name or fn.__name__, "description": description or inspect.getdoc(fn) or fn.__name__}
            if mime_type:
                metadata["mimeType"] = mime_type
            if variables:
                if any(t[0]["uriTemplate"] == uri for t in self._templates):
                    raise ValueError("Duplicate resource template")
                expression = re.escape(uri)
                for v in variables:
                    expression = expression.replace(re.escape("{" + v + "}"), f"(?P<{v}>[^/?#]+)")
                metadata["uriTemplate"] = uri
                self._templates.append((metadata, re.compile(expression), fn))
            else:
                if uri in self._resources:
                    raise ValueError("Duplicate resource URI")
                metadata["uri"] = uri
                self._resources[uri] = (metadata, fn)
            return fn
        return register

    def _resolve_resource(self, uri):
        if not isinstance(uri, str) or not uri or len(uri) > 2048:
            raise RpcError(-32602, "A resource URI of at most 2048 characters is required")
        if uri in self._resources:
            metadata, fn = self._resources[uri]
            return metadata, fn, {}
        for metadata, pattern, fn in self._templates:
            match = pattern.fullmatch(uri)
            if match:
                return metadata, fn, {k: unquote(v) for k, v in match.groupdict().items()}
        raise RpcError(-32002, "Resource not found")

    def notify_resource_updated(self, uri):
        """Thread-safe notification; the polling loop filters active subscriptions."""
        self._resolve_resource(uri)
        self._notifications.put_nowait((self._generation,
            {"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": {"uri": uri}}))

    def prompt(self, name=None, *, description=None):
        """A prompt receives string arguments and returns text or MCP messages."""
        def register(fn):
            self._registration_allowed()
            prompt_name = name or fn.__name__
            if not isinstance(prompt_name, str) or not prompt_name or prompt_name in self._prompts:
                raise ValueError("Prompt name must be nonempty and unique")
            signature = inspect.signature(fn)
            arguments = []
            for p in signature.parameters.values():
                if p.kind not in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY):
                    raise TypeError("Prompts require named parameters")
                if p.default is not p.empty and not isinstance(p.default, str):
                    raise TypeError("Prompt argument defaults must be strings")
                arguments.append({"name": p.name, "required": p.default is p.empty})
            metadata = {"name": prompt_name, "description": description or inspect.getdoc(fn) or prompt_name,
                        "arguments": arguments}
            self._prompts[prompt_name] = (metadata, signature, fn)
            return fn
        return register

    @staticmethod
    def _page(items, params, key):
        if not isinstance(params, dict):
            raise RpcError(-32602, "Parameters must be an object")
        cursor = params.get("cursor", "0")
        if not isinstance(cursor, str) or not cursor.isascii() or not cursor.isdigit():
            raise RpcError(-32602, "Invalid cursor")
        offset = int(cursor)
        if offset > len(items):
            raise RpcError(-32602, "Invalid cursor")
        result = {key: items[offset:offset + 100]}
        if offset + 100 < len(items):
            result["nextCursor"] = str(offset + 100)
        return result

    def _catalog_dispatch(self, method, params):
        if method == "resources/list":
            return self._page([v[0] for v in self._resources.values()], params, "resources")
        if method == "resources/templates/list":
            return self._page([t[0] for t in self._templates], params, "resourceTemplates")
        if method == "prompts/list":
            return self._page([v[0] for v in self._prompts.values()], params, "prompts")
        if not isinstance(params, dict):
            raise RpcError(-32602, "Parameters must be an object")
        if method in ("resources/read", "resources/subscribe", "resources/unsubscribe"):
            uri = params.get("uri")
            if method == "resources/unsubscribe":
                if not isinstance(uri, str):
                    raise RpcError(-32602, "uri must be a string")
                self._subscriptions.discard(uri)
                return {}
            metadata, fn, arguments = self._resolve_resource(uri)
            if method == "resources/subscribe":
                if len(self._subscriptions) >= 1024 and uri not in self._subscriptions:
                    raise RpcError(-32000, "Resource subscription limit reached")
                self._subscriptions.add(uri)
                return {}
            value = invoke(fn, **arguments)
            content = {"uri": uri}
            if isinstance(value, bytes):
                content.update(blob=base64.b64encode(value).decode(), mimeType=metadata.get("mimeType", "application/octet-stream"))
            elif isinstance(value, str):
                content.update(text=value, mimeType=metadata.get("mimeType", "text/plain"))
            else:
                content.update(text=json.dumps(value, ensure_ascii=False, allow_nan=False),
                               mimeType=metadata.get("mimeType", "application/json"))
            return {"contents": [content]}
        if method == "prompts/get":
            name, arguments = params.get("name"), params.get("arguments", {})
            if not isinstance(name, str) or name not in self._prompts:
                raise RpcError(-32602, "Unknown prompt")
            if not isinstance(arguments, dict) or any(not isinstance(v, str) for v in arguments.values()):
                raise RpcError(-32602, "Prompt arguments must be strings")
            metadata, signature, fn = self._prompts[name]
            try:
                signature.bind(**arguments)
            except TypeError as e:
                raise RpcError(-32602, str(e)) from e
            result = invoke(fn, **arguments)
            if isinstance(result, str):
                result = {"messages": [{"role": "user", "content": {"type": "text", "text": result}}]}
            elif isinstance(result, list):
                result = {"messages": result}
            if not isinstance(result, dict) or not isinstance(result.get("messages"), list):
                raise TypeError("Prompt handlers must return text, messages or a messages object")
            for m in result["messages"]:
                if (not isinstance(m, dict) or m.get("role") not in ("user", "assistant")
                        or not isinstance(m.get("content"), dict) or not isinstance(m["content"].get("type"), str)):
                    raise TypeError("Invalid prompt message")
            return {"description": metadata["description"], **result}
        raise RpcError(-32601, "Method not found")
