"""Several independent Provider catalogs published through one C99 tunnel."""
import threading
from urllib.parse import urlsplit

from ._native import Transport
from ._session import serve


class Multiplex:
    def __init__(self, providers, *, secret=None, library=None, buffer_size=None):
        self.providers = list(providers)
        if not 1 <= len(self.providers) <= 1024:
            raise ValueError("Multiplex requires 1 to 1024 providers")
        if len({p.name for p in self.providers}) != len(self.providers):
            raise ValueError("Provider slot names must be unique")
        for p in self.providers:
            if p._group is not None or p._connection is not None:
                raise ValueError("Providers must not already be connected or grouped")
        secrets = {p.secret for p in self.providers if p.secret is not None}
        if secret is None and len(secrets) > 1:
            raise ValueError("One multiplexed connection requires one provider identity")
        self.secret = secret if secret is not None else next(iter(secrets), None)
        if self.secret is not None and (not isinstance(self.secret, str) or any(c in self.secret for c in "\r\n\0")):
            raise ValueError("Invalid provider secret")
        libraries = {str(p.library) for p in self.providers if p.library is not None}
        if library is None and len(libraries) > 1:
            raise ValueError("A group must use one native library")
        self.library = library or next(iter(libraries), None)
        self.buffer_size = buffer_size or max(p.buffer_size for p in self.providers)
        if self.buffer_size < 1024:
            raise ValueError("buffer_size must be at least 1024")
        self._connection = None
        self._stop = threading.Event()
        self._lifecycle = threading.Lock()
        for p in self.providers:
            p._group = self

    def connect(self, url="ws://localhost:3000", *, ca_file=None):
        if not self._lifecycle.acquire(blocking=False):
            raise RuntimeError("Multiplex group is running")
        try:
            parsed = urlsplit(url)
            if (parsed.scheme not in ("ws", "wss") or not parsed.hostname or parsed.path not in ("", "/")
                    or parsed.query or parsed.fragment or parsed.username or parsed.password or "\0" in parsed.hostname):
                raise ValueError("Use a ws:// or wss://host:port base URL")
            self._connection = (parsed.hostname, parsed.port or (443 if parsed.scheme == "wss" else 80))
            self._tls, self._ca_file = parsed.scheme == "wss", ca_file
            self._stop.clear()
        finally:
            self._lifecycle.release()
        return self

    def stop(self):
        self._stop.set()

    def run(self):
        if not self._lifecycle.acquire(blocking=False):
            raise RuntimeError("Multiplex group is already running")
        acquired = []
        try:
            if self._connection is None:
                raise RuntimeError("Call connect() before run()")
            for p in self.providers:
                if not p._lifecycle.acquire(blocking=False):
                    raise RuntimeError(f"Provider {p.name} is already running")
                acquired.append(p)
            transport = Transport(*self._connection, self.providers[0].name, False,
                self.secret, self.buffer_size, self.library, tls=self._tls, ca_file=self._ca_file,
                slots=[(p.name, p.aggregate) for p in self.providers])
            serve(self.providers, transport, self._stop, multiplex=True)
        finally:
            for p in acquired:
                p._lifecycle.release()
            self._lifecycle.release()
