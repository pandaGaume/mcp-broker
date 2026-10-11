import os
import sys
import threading
import time

from mcp_provider import Provider, Multiplex

provider = Provider("python-slot", aggregate=True, secret=os.environ.get("TEST_PROVIDER_SECRET"))
state = {"value": 0}


@provider.tool("echo")
def echo(message: str):
    return {"message": message}


@provider.tool("slow")
def slow(seconds: float):
    time.sleep(seconds)
    return {"slept": seconds}


@provider.tool("fail")
def fail():
    raise RuntimeError("intentional test error")


@provider.tool("update")
def update(value: int):
    state["value"] = value
    provider.notify_resource_updated("memory://state")
    return state.copy()


@provider.resource("memory://state", name="state")
def read_state():
    return state.copy()


@provider.resource("memory://binary", mime_type="application/octet-stream")
def read_binary():
    return b"\x00\xff\x01"


@provider.resource("memory://device/{name}")
def read_device(name: str):
    return {"name": name}


@provider.prompt("diagnostic")
def diagnostic(machine: str, detail: str = "brief"):
    return f"Inspect {machine}. Provide a {detail} diagnosis."


if os.environ.get("TEST_MULTIPLEX"):
    secondary = Provider(os.environ.get("TEST_SECOND_SLOT", "python-secondary"), aggregate=True)

    @secondary.tool("echo")
    def second_echo(message: str):
        return {"slot": secondary.name, "message": message}

    runner = Multiplex([provider, secondary])
else:
    runner = provider


def shutdown():
    sys.stdin.readline()
    runner.stop()


threading.Thread(target=shutdown, daemon=True).start()
runner.connect(sys.argv[1], ca_file=os.environ.get("TEST_CA_FILE") or None).run()
