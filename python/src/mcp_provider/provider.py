import inspect
import json
import logging
import math
import queue
import threading
import types
from concurrent.futures import Future
from typing import Any, Union, get_args, get_origin, get_type_hints
from urllib.parse import urlsplit

from ._native import Transport

log = logging.getLogger(__name__)


class _Worker:
    """Bounded queue, including canceled work waiting behind a long-running call."""
    def __init__(self, provider):
        self.provider = provider
        self.queue = queue.Queue(maxsize=provider.max_pending)
        self.thread = threading.Thread(target=self._run, name=provider.name)
        self.thread.start()

    def submit(self, request):
        future = Future()
        self.queue.put_nowait((future, request))
        return future

    def _run(self):
        while True:
            item = self.queue.get()
            if item is None:
                return
            future, request = item
            if future.set_running_or_notify_cancel():
                try:
                    future.set_result(self.provider._reply(request))
                except BaseException as e:
                    # Surface SystemExit/KeyboardInterrupt instead of losing the worker.
                    future.set_exception(e)

    def close(self):
        # The slot is already released. Running Python code cannot be forcibly stopped.
        while True:
            try:
                item = self.queue.get_nowait()
                if item is not None:
                    item[0].cancel()
            except queue.Empty:
                break
        self.queue.put(None)
        self.thread.join()


class RpcError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def _schema(annotation):
    if annotation in (inspect.Signature.empty, Any):
        return {}
    origin, args = get_origin(annotation), get_args(annotation)
    if origin in (Union, types.UnionType):
        return {"anyOf": [_schema(a) for a in args]}
    if origin is list or annotation is list:
        return {"type": "array", "items": _schema(args[0]) if args else {}}
    if origin is dict or annotation is dict:
        if args and args[0] is not str:
            raise TypeError("JSON object keys must be str")
        return {"type": "object", "additionalProperties": _schema(args[1]) if args else {}}
    names = {str: "string", int: "integer", float: "number", bool: "boolean", type(None): "null"}
    if annotation not in names:
        raise TypeError(f"Unsupported tool annotation: {annotation!r}")
    return {"type": names[annotation]}


def _validate(value, schema):
    if "anyOf" in schema:
        return any(_validate(value, s) for s in schema["anyOf"])
    kind = schema.get("type")
    if kind is None:
        return True
    valid = {
        "string": isinstance(value, str), "boolean": isinstance(value, bool),
        "integer": type(value) is int, "number": type(value) in (int, float),
        "null": value is None, "array": isinstance(value, list), "object": isinstance(value, dict),
    }[kind]
    if not valid:
        return False
    if kind == "number" and isinstance(value, float) and not math.isfinite(value):
        return False
    if kind == "array":
        return all(_validate(v, schema["items"]) for v in value)
    if kind == "object":
        return all(isinstance(k, str) and _validate(v, schema["additionalProperties"])
                   for k, v in value.items())
    return True


class Provider:
    """A dedicated slot. run() owns all C operations; tools execute in one worker.

    stop() is safe from another thread. Register tools before connect().
    A native tool that holds the GIL must release it to let the polling loop run.
    """
    def __init__(self, name, *, aggregate=False, secret=None, library=None,
                 buffer_size=1024 * 1024, max_pending=32):
        if not isinstance(name, str) or not name or "\0" in name or name in ("_all", "_broker"):
            raise ValueError("A non-reserved slot name is required")
        if len(name.encode("utf-8")) >= 64:
            raise ValueError("Slot names must be shorter than 64 UTF-8 bytes")
        if secret is not None and (not isinstance(secret, str) or any(c in secret for c in "\r\n\0")):
            raise ValueError("Provider secret must be a string without CR, LF or NUL")
        if buffer_size < 1024 or max_pending < 1:
            raise ValueError("buffer_size >= 1024 and max_pending >= 1 are required")
        self.name, self.aggregate, self.secret = name, aggregate, secret
        self.library, self.buffer_size, self.max_pending = library, buffer_size, max_pending
        self._tools = {}
        self._connection = None
        self._stop = threading.Event()
        self._lifecycle = threading.Lock()

    def tool(self, name=None, *, description=None):
        def register(fn):
            if self._connection is not None:
                raise RuntimeError("Register tools before connect()")
            if inspect.iscoroutinefunction(fn):
                raise TypeError("Tools must be synchronous functions")
            tool_name = name or fn.__name__
            if not isinstance(tool_name, str) or not 1 <= len(tool_name) <= 64 or any(
                    not (c.isascii() and (c.isalnum() or c in "_.-")) for c in tool_name):
                raise ValueError("Tool names use 1 to 64 ASCII letters, digits, _, . or -")
            if tool_name in self._tools:
                raise ValueError(f"Duplicate tool: {tool_name}")
            signature, hints = inspect.signature(fn), get_type_hints(fn)
            properties, required = {}, []
            for p in signature.parameters.values():
                if p.kind not in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY):
                    raise TypeError("Tools require named parameters, without *args or **kwargs")
                properties[p.name] = _schema(hints.get(p.name, p.annotation))
                if p.default is p.empty:
                    required.append(p.name)
            schema = {"type": "object", "properties": properties, "required": required,
                      "additionalProperties": False}
            metadata = {"name": tool_name, "description": description or inspect.getdoc(fn) or tool_name,
                        "inputSchema": schema}
            self._tools[tool_name] = (fn, signature, metadata)
            return fn
        return register

    def connect(self, url="ws://localhost:3000"):
        """Configure the broker base URL. The first poll performs the connection."""
        if not self._lifecycle.acquire(blocking=False):
            raise RuntimeError("Provider is running")
        try:
            parsed = urlsplit(url)
            if (parsed.scheme != "ws" or not parsed.hostname or parsed.path not in ("", "/")
                    or parsed.query or parsed.fragment or parsed.username or parsed.password
                    or "\0" in parsed.hostname):
                raise ValueError("Use a ws://host:port base URL; this build has no TLS port")
            self._connection = (parsed.hostname, parsed.port or 80)
            self._stop.clear()
        finally:
            self._lifecycle.release()
        return self

    def stop(self):
        self._stop.set()

    def _call(self, params):
        if not isinstance(params, dict):
            raise RpcError(-32602, "Tool parameters must be an object")
        name = params.get("name")
        if not isinstance(name, str) or name not in self._tools:
            raise RpcError(-32602, "Unknown tool")
        fn, signature, metadata = self._tools[name]
        arguments = params.get("arguments", {})
        if not isinstance(arguments, dict):
            raise RpcError(-32602, "Tool arguments must be an object")
        try:
            signature.bind(**arguments)
        except TypeError as e:
            raise RpcError(-32602, str(e)) from e
        for key, value in arguments.items():
            if not _validate(value, metadata["inputSchema"]["properties"][key]):
                raise RpcError(-32602, f"Invalid type for argument {key}")
        try:
            result = fn(**arguments)
            text = json.dumps(result, ensure_ascii=False, allow_nan=False)
            structured = result if isinstance(result, dict) else {"result": result}
            return {"content": [{"type": "text", "text": text}], "structuredContent": structured}
        except Exception as e:
            log.exception("Tool %s failed", name)
            return {"content": [{"type": "text", "text": str(e)}], "isError": True}

    def _dispatch(self, method, params):
        if method == "initialize":
            if not isinstance(params, dict) or not isinstance(params.get("protocolVersion"), str):
                raise RpcError(-32602, "initialize requires protocolVersion")
            supported = ("2024-11-05", "2025-03-26", "2025-06-18")
            version = params["protocolVersion"]
            return {"protocolVersion": version if version in supported else supported[-1],
                    "capabilities": {"tools": {}}, "serverInfo": {"name": self.name, "version": "0.1.0"}}
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": [v[2] for v in self._tools.values()]}
        if method == "tools/call":
            return self._call(params)
        raise RpcError(-32601, "Method not found")

    def _reply(self, request):
        reply = {"jsonrpc": "2.0", "id": request["id"]}
        try:
            reply["result"] = self._dispatch(request["method"], request.get("params", {}))
        except RpcError as e:
            reply["error"] = {"code": e.code, "message": e.message}
        except Exception:
            log.exception("Request dispatch failed")
            reply["error"] = {"code": -32603, "message": "Internal error"}
        return reply

    def run(self):
        """Poll until stop() or Ctrl+C; release the slot, then wait for running tools."""
        if not self._lifecycle.acquire(blocking=False):
            raise RuntimeError("Provider is already running")
        transport, worker = None, None
        try:
            if self._connection is None:
                raise RuntimeError("Call connect() before run()")
            transport = Transport(*self._connection, self.name, self.aggregate, self.secret,
                                  self.buffer_size, self.library)
            worker = _Worker(self)
            pending = []
            while not self._stop.is_set():
                rc, data = transport.poll()
                if rc not in (0, -2):
                    log.warning("Provider %s: %s", self.name, transport.diagnostic(rc))
                generation = transport.generation
                # Replies are sent only on the connection that received the request.
                for future, received_generation in pending[:]:
                    if future.done():
                        pending.remove((future, received_generation))
                        if received_generation == generation and transport.connected:
                            self._send(transport, future.result())
                    elif received_generation != generation or not transport.connected:
                        future.cancel()
                        pending.remove((future, received_generation))
                if data is None:
                    continue
                try:
                    request = json.loads(data, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
                except (ValueError, UnicodeDecodeError):
                    self._send(transport, {"jsonrpc": "2.0", "id": None,
                                           "error": {"code": -32700, "message": "Parse error"}})
                    continue
                if (not isinstance(request, dict) or request.get("jsonrpc") != "2.0"
                        or not isinstance(request.get("method"), str)
                        or ("id" in request and type(request["id"]) not in (str, int, type(None)))):
                    # Server-request replies are not MCP requests and need no response.
                    if isinstance(request, dict) and ("result" in request or "error" in request):
                        continue
                    self._send(transport, {"jsonrpc": "2.0", "id": None,
                                           "error": {"code": -32600, "message": "Invalid Request"}})
                    continue
                if "id" not in request:
                    continue
                if request["method"] == "tools/call":
                    if len(pending) >= self.max_pending:
                        self._send(transport, {"jsonrpc": "2.0", "id": request["id"],
                                               "error": {"code": -32000, "message": "Tool queue is full"}})
                    else:
                        try:
                            pending.append((worker.submit(request), generation))
                        except queue.Full:
                            self._send(transport, {"jsonrpc": "2.0", "id": request["id"],
                                                   "error": {"code": -32000, "message": "Tool queue is full"}})
                else:
                    self._send(transport, self._reply(request))
        except KeyboardInterrupt:
            self.stop()
        finally:
            if transport is not None:
                transport.close()
            if worker is not None:
                worker.close()
            self._lifecycle.release()

    @staticmethod
    def _send(transport, reply):
        try:
            transport.send(json.dumps(reply, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        except OSError as e:
            log.warning("Reply was not sent: %s", e)
