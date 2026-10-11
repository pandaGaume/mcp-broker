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
        "create_ex": ([C.c_char_p, C.c_ushort, C.POINTER(C.c_char_p), C.POINTER(C.c_int),
                       C.c_size_t, C.c_int, C.c_char_p, C.c_size_t, C.c_int, C.c_char_p], C.c_void_p),
        "destroy": ([C.c_void_p], None),
        "poll": ([C.c_void_p, C.POINTER(C.c_void_p), C.POINTER(C.c_size_t), C.c_int], C.c_int),
        "send": ([C.c_void_p, C.c_char_p, C.c_size_t], C.c_int),
        "generation": ([C.c_void_p], C.c_ulong), "connected": ([C.c_void_p], C.c_int),
        "error": ([C.c_int], C.c_char_p), "detail": ([C.c_void_p], C.c_char_p),
        "reason": ([C.c_void_p], C.c_char_p),
        "poll_slot": ([C.c_void_p, C.POINTER(C.c_size_t), C.POINTER(C.c_void_p),
                       C.POINTER(C.c_size_t), C.c_int], C.c_int),
        "send_slot": ([C.c_void_p, C.c_size_t, C.c_char_p, C.c_size_t], C.c_int),
        "refused": ([C.c_void_p, C.c_size_t], C.c_int),
    }
    for name, (args, result) in signatures.items():
        fn = getattr(lib, "mcp_py_" + name)
        fn.argtypes, fn.restype = args, result
    return lib


class Transport:
    def __init__(self, host, port, name, aggregate, secret, capacity, library,
                 *, tls=False, ca_file=None, slots=None):
        self.lib = load_library(library)
        headers = f"X-Provider-Token: {secret}\r\n" if secret else ""
        self.multiplex = slots is not None
        slots = slots or [(name, aggregate)]
        names = (C.c_char_p * len(slots))(*(n.encode() for n, _ in slots))
        aggregates = (C.c_int * len(slots))(*(int(a) for _, a in slots))
        ca = Path(ca_file).read_bytes() if ca_file is not None else None
        if ca is not None and b"\0" in ca:
            raise ValueError("CA PEM must not contain NUL bytes")
        # The host port initializes process-wide Winsock state on first use.
        with _CREATE_LOCK:
            self.handle = self.lib.mcp_py_create_ex(host.encode(), port, names, aggregates,
                len(slots), int(self.multiplex), headers.encode(), capacity, int(tls), ca)
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

    def poll_slot(self, timeout=50):
        ptr, length, slot = C.c_void_p(), C.c_size_t(), C.c_size_t()
        rc = self.lib.mcp_py_poll_slot(self.handle, C.byref(slot), C.byref(ptr), C.byref(length), timeout)
        return rc, slot.value, C.string_at(ptr, length.value) if rc == 0 else None

    def send_slot(self, slot, data):
        rc = self.lib.mcp_py_send_slot(self.handle, slot, data, len(data))
        if rc < 0:
            raise OSError(self.lib.mcp_py_error(rc).decode())

    def refused(self, slot):
        return bool(self.lib.mcp_py_refused(self.handle, slot))

    def diagnostic(self, rc):
        return ": ".join(s.decode("utf-8", "replace") for s in [
            self.lib.mcp_py_error(rc), self.lib.mcp_py_detail(self.handle),
            self.lib.mcp_py_reason(self.handle)] if s)

    def close(self):
        if self.handle:
            self.lib.mcp_py_destroy(self.handle)
            self.handle = None
