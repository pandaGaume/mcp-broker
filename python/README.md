# Python providers over libmcpb

Expose Python functions as MCP tools, resources and prompts on broker slots.
The native `.dll`, `.so` or `.dylib` compiles the existing `c/libmcpb` C99
transport, `c/ports/host` TCP port and OpenSSL TLS port. Python supplies the MCP
dispatcher; WebSocket framing, multiplexed envelopes, registration, heartbeat
and reconnection stay in libmcpb.
There is no Python WebSocket implementation and no Python dependency on an MCP SDK.

## Build and run from this workspace

Requirements: Python 3.10+, CMake 3.16+, and a C compiler (GCC, Clang or MSVC).
OpenSSL development headers and libraries are required: `libssl-dev` on Ubuntu,
`openssl@3` on macOS, or OpenSSL from MSYS2/vcpkg on Windows. If discovery needs
help, pass `-DOPENSSL_ROOT_DIR=/path/to/openssl` to CMake. On macOS this is
typically `-DOPENSSL_ROOT_DIR="$(brew --prefix openssl@3)"`.
Run these commands at the repository root:

```sh
cmake -S python -B python/build
cmake --build python/build --config Release
```

On Windows with MinGW instead of Visual Studio:

```powershell
cmake -S python -B python/build -G "MinGW Makefiles" `
  -DCMAKE_C_COMPILER=C:/msys64/ucrt64/bin/gcc.exe `
  -DCMAKE_MAKE_PROGRAM=C:/msys64/ucrt64/bin/mingw32-make.exe `
  -DOPENSSL_ROOT_DIR=C:/msys64/ucrt64
cmake --build python/build
$env:PYTHONPATH = "$PWD/python/src"
python python/examples/echo.py ws://localhost:3000
```

On Linux/macOS:

```sh
PYTHONPATH=python/src python python/examples/echo.py ws://localhost:3000
```

Start the broker separately, for example with `node node/packages/broker/dist/bin.js`
after building the Node workspace. The sample publishes `echo` and `add` into
`python-slot` and opts into `_all`. MCP clients connect to
`http://localhost:3000/python-slot/mcp` or `http://localhost:3000/_all/mcp`.

`connect()` accepts the broker **base URL**, not `/provider/<name>`.
The C library constructs and encodes that path. Connection begins inside `run()`;
`connect()` returning does not prove the broker accepted the slot.

## Complete runnable example

After compiling the native library, build the broker workspace once and run:

```sh
cd node
npm ci
npm run build
cd ..
node python/examples/complete.mjs
```

This script owns the entire example: it starts a broker bound to `127.0.0.1:3600`,
starts `python/examples/echo.py` with the native binding, waits for the slot via
`_broker`, lists tools, calls `echo` with Unicode, calls `add` directly and via
`_all`, reads resources and a URI template, retrieves a prompt, verifies resource
subscription notifications and calls a second slot sharing the same socket.
It checks the results, then shuts down the provider and broker. It sets
`PYTHONPATH` itself. Use `--port 4000` if port 3600 is already occupied.

Expected output includes:

```text
Published tools: [ 'echo', 'add' ]
Direct echo: { message: 'Bonjour depuis Python 🐍' }
Direct add: { result: 42 }
Aggregated add (default b=1): { result: 42 }
PASS: Python tools, resources, templates, prompts, subscriptions, multiplexing, _all, clean shutdown
```

The same `echo.py` can run independently against your existing broker; omit
`--managed` for normal Ctrl+C shutdown. Replace or extend its decorated
functions to expose your Python, ONNX Runtime or equipment APIs.

Run the same complete example over TLS with:

```sh
node python/examples/complete.mjs --tls
```

This uses the repository's test certificate as a private CA on both clients and
the native Python provider. The certificate and key are test fixtures, not
deployment credentials. Every TLS connection verifies the certificate chain
and host name; there is no insecure bypass.

## Application API

```python
from mcp_provider import Provider

provider = Provider("python-slot", aggregate=True)

@provider.tool("onnx.infer")
def infer(model: str, data: list[float]) -> dict:
    # Supply your own model loader and inference implementation.
    return {"output": run_inference(model, data).tolist()}

provider.connect("ws://localhost:3000")
provider.run()
```

Functions keep their normal Python calling behavior after decoration. Names,
docstrings and parameter annotations generate `tools/list` metadata and JSON
schemas. Supported annotations are `str`, `int`, `float`, `bool`, `None`,
`list[T]`, `dict[str, T]`, unions and `Any`. Unannotated parameters accept any
JSON value. Defaults make parameters optional. Arguments are checked before
execution; unknown tools, missing arguments, extra keys and wrong types yield
`-32602`. Execution exceptions and non-JSON results yield `isError: true`.

Results must be JSON serializable. Convert NumPy/ONNX tensors explicitly with
`.tolist()`. Results include JSON text and `structuredContent`; scalar/array
results are wrapped as `{"result": value}` for structured content.

Pass `secret=` to send `X-Provider-Token` for an authenticated broker. Read it
from an environment variable or secret store. The wrapper rejects header injection.
`aggregate=False` is the default; opt in explicitly to publish tools in `_all`.
Read aggregated tool names from `tools/list` and use the returned names verbatim.

### Resources and subscriptions

```python
state = {"temperature": 22.5}

@provider.resource("plant://temperature", mime_type="application/json")
def temperature():
    return state.copy()

@provider.resource("plant://equipment/{name}", mime_type="text/plain")
def equipment(name: str):
    return f"Equipment: {name}"

@provider.tool("temperature.set")
def set_temperature(value: float):
    state["temperature"] = value
    provider.notify_resource_updated("plant://temperature")
    return state.copy()
```

Resource handlers return `str` (text), `bytes` (base64 blob), or a JSON-serializable
value. `resources/list`, `resources/templates/list` and `resources/read` expose
the catalog and contents. URI templates support distinct simple `{parameter}`
expansions; matched arguments are percent-decoded strings. Unsupported template
operators are rejected when registering the handler.

`resources/subscribe` and `resources/unsubscribe` track exact URIs. Call
`notify_resource_updated(uri)` after changing a resource, from a tool or another
thread. The polling thread sends notifications only for active subscriptions;
the broker handles per-client routing and reference counts. Subscriptions are
cleared locally on disconnect, then restored by the broker's reconnect replay.
The notification queue is bounded at 1024 entries and raises `queue.Full` when
saturated. Notifications belonging to an earlier connection are discarded.
Resources are accessed on their own slot; `_all` aggregates tools and prompts.

### Prompts

```python
@provider.prompt("diagnostic-machine")
def diagnostic(machine: str, detail: str = "brief"):
    return f"Analyze the measurements of {machine} and provide a {detail} diagnosis."
```

`prompts/list` publishes names and required/optional argument metadata.
`prompts/get` calls the handler with string arguments. A handler can return a
string (one user text message), a list of MCP prompt messages, or an object with
`messages` and an optional `description`. Message roles are `user` or `assistant`.
Prompts also appear in `_all`, under the names returned by its `prompts/list`.

### Multiple slots over one connection

```python
from mcp_provider import Provider, Multiplex

inference = Provider("inference", aggregate=True)
equipment = Provider("equipment", aggregate=False)
# Register tools, resources and prompts on each Provider before creating the group.
group = Multiplex([inference, equipment], secret=provider_secret)
group.connect("wss://broker.example:3000", ca_file="company-ca.pem")
group.run()
```

`Multiplex` publishes every slot through the native `/providers` endpoint on
one socket. Each slot has its own catalog, subscriptions and bounded worker
queue. Slot names must be unique, and the connection has one provider identity.
One slot being refused does not stop accepted slots. Call `group.stop()` or
`stop()` on any member to stop the whole group; run the group instead of members.

### TLS and asynchronous handlers

`Provider.connect()` and `Multiplex.connect()` accept `ws://` and `wss://` base
URLs. Pass `ca_file="ca.pem"` for a private CA; otherwise OpenSSL uses its default
trust store. Default ports are 80 and 443. An invalid CA fails initialization,
and handshake or certificate failures are logged before the native retry.

Tools, resource readers and prompt handlers may be `async def`. Their coroutines
run in the slot worker using a fresh asyncio loop per invocation, leaving native
polling responsive. For libraries that need one persistent event loop, maintain
a dedicated loop and bridge calls to it rather than sharing connections across
the per-invocation loops. Register all handlers before connecting or grouping.
Listings use pages of 100 entries and accept the returned opaque `nextCursor`.

## Native boundary and lifetime

The shim allocates one opaque handle with owned configuration strings, host-port
context and receive buffer. The C99 core is unchanged and still allocation free.
`ctypes.CDLL` releases the GIL during C calls. Received JSON bytes are copied
before the next poll, so Python never retains borrowed C pointers.

`run()` owns every native operation, including destruction. One worker per slot
executes tools, resource readers and prompt handlers in order; only JSON results
pass back to the polling loop.
The queue is bounded (`max_pending=32` by default). Slow inference does not
block C polling, provided its native extension releases the GIL. An extension
that holds the GIL for long periods should run in a separate process.
There are no C-to-Python callbacks to keep alive in this implementation.

On disconnect, queued work is canceled and replies from the previous connection
are discarded. Already executing Python work cannot be forcibly canceled.
`stop()` is safe from another thread; Ctrl+C also stops `run()`. Shutdown
releases the native socket and buffers first, cancels queued tools, then waits
for the running tool. Socket connect/handshake waits can delay shutdown by the
native defaults (10 s / 5 s). Keep tools within the broker request timeout.

The binding supports dedicated and multiplexed slots, TLS, tools, text/binary
resources, URI templates, resource subscriptions, prompts and async handlers.
It advertises only the capabilities it implements. The broker's existing limits
on server-to-client requests still apply. Provider authorization declarations,
task orchestration and telemetry APIs are separate from these MCP catalogs.

## Installation outside the source checkout

The loader searches next to the package, then the workspace build directory
(including `Release/`). Set `MCP_PROVIDER_LIBRARY` to an absolute library path
to override discovery. To package a compiled library alongside the Python code:

```sh
cmake --install python/build --config Release --prefix python/src
python -m pip install ./python
```

Build and install on the target platform and architecture. This first source
package requires the explicit CMake build; it does not auto-build the native
library during pip installation or publish portable binary wheels.

## Verification

With `PYTHONPATH` set to `python/src`:

```sh
python -m unittest discover -s python/tests -v
node python/tests/roundtrip.mjs
node python/tests/features.mjs
node python/examples/complete.mjs --tls
```

The roundtrip uses the built Node broker (`cd node && npm ci && npm run build`),
an ephemeral port, a provider identity and an authenticated HTTP client. It
checks Unicode, arguments, tool errors, heartbeats during a slow call, `_all`
membership and graceful slot release. The feature tests cover dedicated and
multiplexed `ws://` and `wss://` connections, resources and binary contents, URI
templates, prompt aggregation, subscription routing and replay, partial slot
refusal and rejection of an untrusted certificate. Set `PYTHON` if the interpreter has a
different executable name. Open `mcp-broker.code-workspace` to see the `python`
workspace folder.

## Prospective: which Python slots could we expose?

The proposals below are candidate adapters, not implemented slots. The runnable
example provides demonstration tools, resources and prompts. Each link points to the
relevant library documentation. Difficulty ratings are our estimates of the
integration work needed for a first useful adapter with this binding, assuming
the data, models or equipment are available. They exclude model training and
qualification of an industrial installation.

Scale: **1/5** = a few functions and JSON conversion; **2/5** = formats and state
to manage; **3/5** = a model or persistent connection; **4/5** = hardware, GPU,
streams or a complex lifecycle; **5/5** = binding extensions or orchestration
of long-running jobs required. Slot and tool names are illustrative.

| Potential slot | Python library | Example MCP tools | Practical value | Difficulty and main implementation work |
|---|---|---|---|---|
| `numerics` | [NumPy](https://numpy.org/doc/stable/user/absolute_beginners.html) | `array.stats`, `matrix.multiply` | Compute on measurements, vectors and matrices without requiring the MCP client to carry a scientific stack. | **1/5**: convert lists and arrays, check dimensions and convert NumPy scalars to JSON. |
| `symbolic` | [SymPy](https://docs.sympy.org/latest/tutorials/intro-tutorial/index.html) | `expression.simplify`, `equation.solve` | Symbolic computation, formula verification and exact solutions for engineering tools. | **2/5**: define an accepted expression language, represent solutions as strings or JSON objects and bound expensive computations. |
| `signal-analysis` | [SciPy](https://docs.scipy.org/doc/scipy/tutorial/index.html) | `signal.peaks`, `signal.spectrum`, `curve.fit` | Vibration analysis, sensor diagnostics and curve fitting. | **2/5** for data blocks: specify units, sampling frequency and parameters; convert arrays into compact results. |
| `dataframes` | [pandas](https://pandas.pydata.org/docs/getting_started/overview.html) | `dataset.describe`, `dataset.aggregate` | Summarize and compare historical records or tabular datasets. | **2/5**: handle dates, missing values and row conversion; limit and paginate results. |
| `analytics-sql` | [DuckDB](https://duckdb.org/docs/stable/clients/python/overview) | `dataset.schema`, `dataset.query` | Analyze CSV/Parquet files and produce metrics without a separate database server. | **2/5** with predefined queries: maintain a connection, parameterize filters, define accessible datasets and bound results. An arbitrary SQL API requires more work. |
| `image-processing` | [Pillow](https://pillow.readthedocs.io/en/stable/handbook/overview.html) | `image.inspect`, `image.resize`, `image.convert` | Prepare images for inspection, model inference or reports. | **2/5**: define inputs as file identifiers, handle formats and dimensions; return metadata and a reference to the generated file. |
| `geometry` | [Shapely](https://shapely.readthedocs.io/en/stable/manual.html) | `geometry.distance`, `geometry.intersection` | Compute areas, intersections and proximity for mapping, layout planning or simulation. | **2/5**: GeoJSON conversion, geometry validation and an explicit coordinate system. |
| `predictive-maintenance` | [scikit-learn](https://scikit-learn.org/stable/user_guide.html) | `model.predict`, `model.score`, `anomaly.detect` | Serve an existing classification, regression or anomaly detection model on measurements. | **3/5**: load a known model once, reproduce preprocessing and feature order, identify its version and handle prediction formats. |
| `onnx-inference` | [ONNX Runtime](https://onnxruntime.ai/docs/get-started/with-python.html) | `model.describe`, `onnx.infer` | Make an exported model available to any MCP client, on CPU or a suitable accelerated backend. | **3/5** on CPU, **4/5** with GPU: session caching, tensor types and shapes, backend installation, memory and execution-time management. |
| `vision-inspection` | [OpenCV](https://docs.opencv.org/4.x/d6/d00/tutorial_py_root.html) | `image.edges`, `image.measure`, `camera.inspect` | Visual inspection, measurements and preprocessing of equipment images. | **3/5** for still images, **4/5** with a camera: calibration, acquisition, device cleanup and structured results. Continuous video requires an additional mechanism. |
| `torch-inference` | [PyTorch](https://docs.pytorch.org/docs/stable/generated/torch.autograd.grad_mode.inference_mode.html) | `model.predict`, `model.status` | Expose a model whose operators or preprocessing remain specific to PyTorch. | **4/5**: load the model, enable evaluation and inference modes, manage CPU/GPU, memory and concurrency; convert tensors to JSON. |
| `text-models` | [Transformers](https://huggingface.co/docs/transformers/en/pipeline_tutorial) | `text.classify`, `text.summarize`, `text.extract` | Classification, summarization or extraction using a local model suited to the domain. | **4/5** for short calls: model selection and loading, tokenization, length and memory limits. Long or streamed generation reaches **5/5** with the current binding. |
| `serial-instruments` | [pySerial](https://pyserial.readthedocs.io/en/latest/shortintro.html) | `instrument.identify`, `instrument.read` | Give a USB/serial instrument or equipment with a proprietary protocol an MCP interface. | **3/5** with a documented protocol: message boundaries, timeouts, exclusive access and reconnection; keep the port in the worker. |
| `modbus-python` | [PyModbus](https://pymodbus.readthedocs.io/en/latest/) | `registers.read`, `device.status` | Adapt existing Python application code around Modbus registers or add preprocessing close to the equipment. | **3/5**: register mapping, types and byte order, persistent connections and timeouts. Reusing the slot of equipment already covered by `mcp-modbus` can avoid a redundant adapter. |
| `opcua-gateway` | [asyncua](https://opcua-asyncio.readthedocs.io/en/latest/) | `nodes.browse`, `node.read`, `method.call` | Expose a domain-specific subset of an OPC UA server to MCP clients. | **4/5**: sessions, certificates, node identifiers and a synchronous bridge or dedicated asyncio loop. Map OPC UA subscription changes to resource updates through `notify_resource_updated`. |
| `can-diagnostics` | [python-can](https://python-can.readthedocs.io/en/stable/) | `bus.status`, `bus.capture` | Diagnose test benches, machines or CAN networks through a Python gateway. | **4/5**: backends and drivers, hardware access and bounded capture; add a domain layer to decode frames. Continuous bus processing requires a separate acquisition loop. |

### Proposed development order

1. **NumPy / SciPy**: validate typed numerical inputs, compact results and useful
   computations with little infrastructure.
2. **ONNX Runtime on CPU**: implement the original `onnx.infer` use case with a
   known model and preprocessing, then extend to GPU if needed.
3. **DuckDB or pandas**: expose historical data and statistics that can feed the
   same models or diagnostics.
4. **Industrial gateway according to actual needs**: complement existing slots
   with pySerial, asyncua or python-can; reuse `mcp-modbus` for equipment it
   already covers.

This order is an architectural proposal to adjust to the libraries and equipment
already in use. Expose domain functions with stable schemas, such as
`vibration.analyze`, rather than an entire library API.

### What these adaptations require

A slot is a JSON interface. Small arrays can travel directly in arguments and
results; images, large tensors and tables should instead use file or dataset
identifiers, with summarized results. Resource readers can return text, JSON or
base64-encoded binary contents. Large payloads should remain outside the JSON
transport and be referenced by the adapter.

A hardware connection or model can remain loaded in the provider worker. For
operations longer than the broker timeout, design `job.start` / `job.status`
tools and their lifecycle management. Resource subscriptions and async handlers
are supported. Progressive tool results and provider authorization declarations
need application or binding extensions, even though some underlying mechanisms
already exist in the broker. The C99 transport can remain shared across adapters.
