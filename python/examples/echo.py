"""Run with PYTHONPATH=python/src and a built native library."""
import logging
import os
import sys
import threading
from mcp_provider import Provider, Multiplex

provider = Provider("python-slot", aggregate=True)
state = {"result": 0}


@provider.tool("echo")
def echo(message: str) -> dict:
    """Return a Unicode message unchanged."""
    return {"message": message}


@provider.tool("add")
def add(a: float, b: float = 1) -> float:
    """Add two numbers."""
    state["result"] = a + b
    provider.notify_resource_updated("python://sum")
    return state["result"]


@provider.resource("python://sum", name="latest-sum", mime_type="application/json")
def latest_sum():
    """The latest computed sum."""
    return state.copy()


@provider.resource("python://greeting/{name}", mime_type="text/plain")
def greeting(name: str):
    return f"Hello, {name}!"


@provider.prompt("review-sum")
def review_sum(expression: str, style: str = "brief"):
    """Prepare a request to review a calculation."""
    return f"Review the calculation {expression}. Give a {style} explanation."


if "--multiplex" in sys.argv:
    diagnostics = Provider("python-diagnostics", aggregate=True)

    @diagnostics.tool("health")
    def health():
        return {"status": "ready", "slot": diagnostics.name}

    runner = Multiplex([provider, diagnostics])
else:
    runner = provider


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if "--managed" in sys.argv:
        # The complete example controls shutdown without terminating the process.
        def shutdown():
            sys.stdin.readline()
            runner.stop()

        threading.Thread(target=shutdown, daemon=True).start()
    runner.connect(sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:3000",
                   ca_file=os.environ.get("MCP_PROVIDER_CA_FILE"))
    runner.run()
