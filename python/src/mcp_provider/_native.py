"""Owned ctypes transport. Every handle operation belongs to the polling thread."""
import ctypes as C
import os
from pathlib import Path
import sys
import threading

_CREATE_LOCK = threading.Lock()


def load_library(path=None):
    filename = {"win32": "mcp_provider_native.dll", "darwin": "libmcp_provider_native.dylib"}.get(
        sys.platform, "libmcp_provider_native.so")
    package = Path(__file__).resolve().parent
    explicit = path or os.environ.get("MCP_PROVIDER_LIBRARY")
    candidates = [Path(explicit)] if explicit else [
        package / filename, package.parents[1] / "build" / filename,
        package.parents[1] / "build" / "Release" / filename,
    ]
    found = next((p for p in candidates if p.is_file()), None)
    if found is None:
        raise RuntimeError("Build the native library with cmake -S python -B python/build, "
                           "then cmake --build python/build; or set MCP_PROVIDER_LIBRARY")
    lib = C.CDLL(str(found.resolve()))  # Releases the GIL during blocking C calls.
    signatures = {
        "create": ([C.c_char_p, C.c_ushort, C.c_char_p, C.c_int, C.c_char_p, C.c_size_t], C.c_void_p),
        "destroy": ([C.c_void_p], None),
        "poll": ([C.c_void_p, C.POINTER(C.c_void_p), C.POINTER(C.c_size_t), C.c_int], C.c_int),
        "send": ([C.c_void_p, C.c_char_p, C.c_size_t], C.c_int),
        "generation": ([C.c_void_p], C.c_ulong), "connected": ([C.c_void_p], C.c_int),
        "error": ([C.c_int], C.c_char_p), "detail": ([C.c_void_p], C.c_char_p),
        "reason": ([C.c_void_p], C.c_char_p),
    }
    for name, (args, result) in signatures.items():
        fn = getattr(lib, "mcp_py_" + name)
        fn.argtypes, fn.restype = args, result
    return lib


class Transport:
    def __init__(self, host, port, name, aggregate, secret, capacity, library):
        self.lib = load_library(library)
        headers = f"X-Provider-Token: {secret}\r\n" if secret else ""
        # The host port initializes process-wide Winsock state on first use.
        with _CREATE_LOCK:
            self.handle = self.lib.mcp_py_create(host.encode(), port, name.encode(),
                                                int(aggregate), headers.encode(), capacity)
        if not self.handle:
            raise RuntimeError("Native provider initialization failed")

    @property
    def generation(self):
        return self.lib.mcp_py_generation(self.handle)

    @property
    def connected(self):
        return bool(self.lib.mcp_py_connected(self.handle))

    def poll(self, timeout=50):
        ptr, length = C.c_void_p(), C.c_size_t()
        rc = self.lib.mcp_py_poll(self.handle, C.byref(ptr), C.byref(length), timeout)
        # Copy now: C owns this buffer and the next poll overwrites it.
        return rc, C.string_at(ptr, length.value) if rc == 0 else None

    def send(self, data):
        rc = self.lib.mcp_py_send(self.handle, data, len(data))
        if rc < 0:
            raise OSError(self.lib.mcp_py_error(rc).decode())

    def diagnostic(self, rc):
        return ": ".join(s.decode("utf-8", "replace") for s in [
            self.lib.mcp_py_error(rc), self.lib.mcp_py_detail(self.handle),
            self.lib.mcp_py_reason(self.handle)] if s)

    def close(self):
        if self.handle:
            self.lib.mcp_py_destroy(self.handle)
            self.handle = None
