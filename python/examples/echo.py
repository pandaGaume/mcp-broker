"""Run with PYTHONPATH=python/src and a built native library."""
import logging
import sys
import threading
from mcp_provider import Provider

provider = Provider("python-slot", aggregate=True)


@provider.tool("echo")
def echo(message: str) -> dict:
    """Return a Unicode message unchanged."""
    return {"message": message}


@provider.tool("add")
def add(a: float, b: float = 1) -> float:
    """Add two numbers."""
    return a + b


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if "--managed" in sys.argv:
        # The complete example controls shutdown without terminating the process.
        def shutdown():
            sys.stdin.readline()
            provider.stop()

        threading.Thread(target=shutdown, daemon=True).start()
    provider.connect(sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:3000")
    provider.run()
