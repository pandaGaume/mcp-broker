"""Single native polling owner for one or many MCP server slots."""
import json
import logging
import queue

log = logging.getLogger(__name__)


class _Endpoint:
    def __init__(self, transport, slot, multiplex):
        self.transport, self.slot, self.multiplex = transport, slot, multiplex

    def send(self, data):
        if self.multiplex:
            return self.transport.send_slot(self.slot, data)
        return self.transport.send(data)


def serve(providers, transport, stop, *, multiplex=False):
    from .provider import _Worker
    workers, pending = [], [[] for _ in providers]
    endpoints = [_Endpoint(transport, i, multiplex) for i in range(len(providers))]
    try:
        for provider in providers:
            workers.append(_Worker(provider))
        while not stop.is_set():
            if multiplex:
                rc, slot, data = transport.poll_slot()
            else:
                rc, data = transport.poll()
                slot = 0
            if rc not in (0, -2):
                log.warning("Provider link: %s", transport.diagnostic(rc))
            generation = transport.generation
            connected = transport.connected
            for i, provider in enumerate(providers):
                usable = connected and not (multiplex and transport.refused(i))
                if generation != provider._generation or not usable:
                    provider._subscriptions.clear()
                    provider._generation = generation
                while not provider._notifications.empty():
                    notified_generation, notification = provider._notifications.get_nowait()
                    if (notified_generation == generation and usable
                            and notification["params"]["uri"] in provider._subscriptions):
                        provider._send(endpoints[i], notification)
                for future, received_generation in pending[i][:]:
                    if future.done():
                        pending[i].remove((future, received_generation))
                        if received_generation == generation and usable:
                            provider._send(endpoints[i], future.result())
                    elif received_generation != generation or not usable:
                        future.cancel()
                        pending[i].remove((future, received_generation))
            if data is None or slot >= len(providers):
                continue
            provider, endpoint = providers[slot], endpoints[slot]
            try:
                request = json.loads(data, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
            except (ValueError, UnicodeDecodeError):
                provider._send(endpoint, {"jsonrpc": "2.0", "id": None,
                    "error": {"code": -32700, "message": "Parse error"}})
                continue
            if (not isinstance(request, dict) or request.get("jsonrpc") != "2.0"
                    or not isinstance(request.get("method"), str)
                    or ("id" in request and type(request["id"]) not in (str, int, type(None)))):
                if isinstance(request, dict) and ("result" in request or "error" in request):
                    continue
                provider._send(endpoint, {"jsonrpc": "2.0", "id": None,
                    "error": {"code": -32600, "message": "Invalid Request"}})
                continue
            if "id" not in request:
                continue
            if request["method"] in ("tools/call", "resources/read", "prompts/get"):
                try:
                    if len(pending[slot]) >= provider.max_pending:
                        raise queue.Full
                    pending[slot].append((workers[slot].submit(request), generation))
                except queue.Full:
                    provider._send(endpoint, {"jsonrpc": "2.0", "id": request["id"],
                        "error": {"code": -32000, "message": "Handler queue is full"}})
            else:
                provider._send(endpoint, provider._reply(request))
    except KeyboardInterrupt:
        stop.set()
    finally:
        try:
            transport.close()
        finally:
            for provider in providers:
                provider._subscriptions.clear()
                provider._generation = 0
            for worker in workers:
                worker.close()
