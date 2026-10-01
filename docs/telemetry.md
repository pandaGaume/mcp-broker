# Provider telemetry

This extension transports trace spans from an MCP provider to an observability
backend without coupling firmware to an OpenTelemetry SDK. It is optional on
both sides:

- a provider that emits no telemetry behaves exactly as before;
- a broker without a telemetry exporter consumes and drops telemetry
  notifications instead of broadcasting them to MCP clients;
- enabling or disabling provider tracing does not reconnect the provider and
  does not change its MCP resources or tools.

The current signal is distributed tracing. The wire envelope is generic and
versioned so metrics or logs can be added later without overloading trace
semantics.

## Responsibility split

| Layer | Responsibility |
|---|---|
| MCP service, such as `McpModbusService` | Decides when tracing is enabled, creates IDs, names spans, records domain attributes and optional PDU events |
| `libmcpb` | Encodes the notification into a caller-owned buffer and transports the bytes, with no allocation |
| `mcp-broker` | Validates, bounds, queues, enriches with the slot name and dispatches batches |
| OTLP exporter | Converts the compact span to OTLP/HTTP JSON and sends it to a collector |
| OpenTelemetry Collector | Routes, samples, redacts and exports traces to the deployment backend |

The broker does not inspect Modbus, store PDUs, or decide whether a device may
be traced. Those policies belong to the service that owns the protocol and its
data sensitivity.

## End-to-end correlation

One W3C trace ID follows the operation across the whole service:

```text
MCP tools/call
    traceId T, MCP span M
        |
        v
McpModbusService dispatch
    child span C, parent M
        |
        +-- event modbus.pdu.tx
        +-- event modbus.pdu.rx
        |
        v
MCP result or error
    span C completed
        |
        v
notifications/telemetry
        |
        v
mcp-broker bounded queue
        |
        v
OTLP/HTTP collector
```

If the service represents the whole operation as one span, the MCP request,
PDU transmit, PDU receive and MCP response can be span events. If it represents
the Modbus transaction as a child span, `parentSpanId` links it to the MCP
operation. Both forms remain one trace because `traceId` is unchanged.

The service must retain the request trace context until the response is
validated. This matches the Modbus PDU lifetime: the request buffer may be
returned to its pool after validation, while the trace record retains only the
selected metadata or copied bytes allowed by policy.

## Provider wire contract

Providers send one JSON-RPC notification per completed span:

```json
{
    "jsonrpc": "2.0",
    "method": "notifications/telemetry",
    "params": {
        "version": 1,
        "signal": "traces",
        "span": {
            "traceId": "0123456789abcdef0123456789abcdef",
            "spanId": "0123456789abcdef",
            "parentSpanId": "fedcba9876543210",
            "name": "modbus.read_input_registers",
            "kind": 3,
            "startTimeUnixNano": "1720000000000000000",
            "endTimeUnixNano": "1720000000001000000",
            "attributes": {
                "rpc.system": "mcp",
                "rpc.method": "tools/call",
                "modbus.transport": "tcp",
                "modbus.unit_id": 1,
                "modbus.function_code": 4,
                "modbus.address": 0,
                "modbus.quantity": 2
            },
            "events": [
                {
                    "name": "modbus.pdu.tx",
                    "timeUnixNano": "1720000000000100000",
                    "attributes": { "network.io.bytes": 5 }
                },
                {
                    "name": "modbus.pdu.rx",
                    "timeUnixNano": "1720000000000900000",
                    "attributes": { "network.io.bytes": 6 }
                }
            ],
            "status": { "code": 1 }
        }
    }
}
```

Validation rules:

- `traceId` is 32 lowercase hexadecimal characters and is not all zero;
- `spanId` and optional `parentSpanId` are 16 lowercase hexadecimal characters
  and are not all zero;
- timestamps are decimal strings in nanoseconds, which avoids precision loss in
  JSON runtimes;
- `kind` uses the OpenTelemetry values 0 through 5;
- `status.code` uses 0 unset, 1 OK, or 2 error;
- attributes are scalar strings, finite numbers, or booleans;
- one span or event has at most 64 attributes by default;
- one span has at most 32 events by default.

An invalid notification is dropped and counted. It is never passed through to
clients as an ordinary MCP notification.

## MCU encoding

`libmcpb` exposes one allocation-free codec:

```c
#include "mcpb/mcpb_telemetry.h"

char frame[768];
int length = mcpb_telemetry_encode(span_json, span_json_length,
                                   frame, sizeof(frame));
if (length >= 0)
    mcpb_provider_send(&provider, frame, (size_t)length);
```

The caller owns `span_json` and `frame`. The codec copies the span verbatim,
adds the versioned JSON-RPC envelope and a trailing NUL, and returns
`MCPB_ERR_TOO_LARGE` when the buffer cannot contain the result. A multiplexed
gateway sends the same encoded frame with `mcpb_mux_send` on the chosen slot.

No queue exists in `libmcpb`. A disconnected link or a full application trace
buffer drops telemetry according to the firmware policy. Control responses
must always take priority over observability traffic.

## Broker queue and failure isolation

Default limits:

| Limit | Default |
|---|---:|
| notification size | 65536 bytes |
| queued spans | 256 |
| exporter batch | 32 spans |
| attributes per span or event | 64 |
| events per span | 32 |

The provider receive path only validates and enqueues. Export runs
asynchronously. When the queue is full, the new span is dropped. Failed export
batches are not retried inside the broker because an unavailable observability
backend must not grow memory use or delay machine control.

`WsTunnel.getTelemetryStats()` returns:

```ts
{
    enabled,
    accepted,
    exported,
    droppedInvalid,
    droppedOversize,
    droppedQueueFull,
    droppedExporter,
    exportErrors,
    queued
}
```

Use these counters for broker Health. Use the provider's own counters for MCU
Health so a lost trace before transport is visible too.

## Configuration

The CLI accepts standard OpenTelemetry variables:

```powershell
$env:OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector:4318/v1/traces"
$env:OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer%20token"
mcp-broker
```

Equivalent `config.json`:

```json
{
    "telemetry": {
        "otlpHttpEndpoint": "http://collector:4318/v1/traces",
        "timeoutMs": 5000,
        "serviceNamespace": "factory-gateway",
        "maxFrameBytes": 65536,
        "queueCapacity": 256,
        "batchSize": 32,
        "maxAttributes": 64,
        "maxEvents": 32
    }
}
```

Programmatic setup:

```ts
const tunnel = new WsTunnelBuilder()
    .withOtlpHttpTelemetry(
        { endpoint: "http://collector:4318/v1/traces" },
        { queueCapacity: 512, batchSize: 32 }
    )
    .build();
```

`withTelemetry({ exporter })` accepts a custom bounded destination adapter when
the host already owns an OpenTelemetry SDK, a file sink, Kafka, or another
transport.

## Collector example

Minimal OpenTelemetry Collector configuration:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  debug:
    verbosity: detailed

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
```

The broker sets OTLP resource attributes `service.name` and
`mcp.provider.slot` to the provider slot, and `service.namespace` to
`mcp-broker.provider` unless configured otherwise.

## PDU data and security

Packet metadata is safe enough for normal tracing. Raw PDU bytes can contain
register values, commands, identifiers or production data. They are disabled
by convention and should only be attached while an authorized runtime trace
session explicitly requests packet capture.

When raw bytes are enabled:

- cap their length before encoding;
- record whether the value was truncated;
- redact configured register ranges;
- keep the capture window bounded by time and record count;
- protect the collector endpoint and its retention policy;
- never let exporter backpressure delay a Modbus response.

The recommended representation is a hexadecimal string event attribute such
as `modbus.pdu.hex`, not a new wire field. This keeps the trace schema generic
and lets collector processors remove the attribute before external export.

