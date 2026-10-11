import os
import sys
import threading
import time

from mcp_provider import Provider

provider = Provider("python-slot", aggregate=True, secret=os.environ.get("TEST_PROVIDER_SECRET"))


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


def shutdown():
    sys.stdin.readline()
    provider.stop()


threading.Thread(target=shutdown, daemon=True).start()
provider.connect(sys.argv[1]).run()
