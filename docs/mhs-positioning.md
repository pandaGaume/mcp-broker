# MCP Broker and the Model Hardware Standard

## Status of this note

Anthropic announced the Model Hardware Standard (MHS) as a research preview in August 2026. The specification and reference drivers are not public yet. This note therefore describes a possible relationship between MHS and `mcp-broker`; it is not an implementation plan or a claim of compatibility.

Source: [Previewing the Model Hardware Standard](https://www.anthropic.com/news/model-hardware-standard-research-preview), Anthropic.

## What MHS appears to cover

MHS is intended to give agents a common interface to physical devices. Anthropic describes device drivers, a shared state dictionary, command execution, live data streams, and checks that block unsafe operations before equipment moves.

The initial examples come from laboratory automation and microscopy. They combine liquid handlers, robot arms, cameras, plate readers, and vendor software. The same model could apply to industrial assets, sensors, mobile robots, or embedded controllers, provided the equipment exposes an API, SDK, or controllable software interface.

Some details remain unknown until the specification is released: identity, authorization, discovery semantics, schema evolution, transport requirements, timing guarantees, and the boundary between a driver and an orchestrator.

## Where MCP and MHS differ

MCP is an agent-facing protocol. It describes tools, resources, prompts, sessions, and transports that a model client can use.

MHS is device-facing. Based on the research preview, its job is to expose hardware state and operations through a uniform runtime interface. It also needs to account for physical constraints that ordinary software tools do not have, such as calibration, emergency stops, reachability, stale state, and irreversible motion.

The two standards can meet at a bridge:

```text
MCP client or agent
        |
        v
    mcp-broker
        |
        +-- MCP software provider
        +-- MCP data provider
        +-- MCP provider backed by MHS
                              |
                              +-- microscope
                              +-- robot arm
                              +-- sensor array
                              +-- laboratory instrument
```

From the broker's point of view, an MHS-backed provider is still an MCP provider. The MHS-specific work stays behind that provider boundary.

## A possible mapping

An MHS bridge could expose device commands as MCP tools and state as MCP resources. This mapping is plausible, but it needs to follow the public MHS specification once available.

| MHS concept described in the preview | Possible MCP representation |
|---|---|
| Device operation or command | Tool |
| Device state slot | Resource |
| Image, time series, spectrum, or telemetry stream | Resource plus change notifications, or a dedicated streaming transport |
| Device inventory and capabilities | Resources and resource templates |
| Safety condition or interlock | Resource state and a mandatory precondition checked by the bridge |
| Driver metadata | Provider metadata exposed through the broker |

Low-rate state fits MCP resources reasonably well. High-frequency streams may not. Cameras, vibration sensors, and control loops can produce data at rates where JSON-RPC becomes wasteful or introduces unacceptable latency. In those cases MCP should carry discovery, intent, and control metadata while MHS or another data plane carries the stream.

## Why the bridge belongs outside the broker core

`mcp-broker` currently routes providers and exposes its own inventory through the reserved `_broker` provider. Adding MHS parsing directly to the routing core would couple the broker to a specification that is still private and changing.

A separate provider or adapter keeps that dependency contained:

```text
@cyanmycelium/mcp-broker
    routing, sessions, provider inventory, grammars

future MHS bridge
    MHS driver discovery, state mapping, command validation,
    MCP tools and resources generated from device capabilities
```

This also leaves room for more than one MHS implementation. A laboratory bridge may need different policies from an industrial bridge even if both speak the same hardware protocol.

## How existing broker features help

Named provider slots give each hardware endpoint a stable MCP address. The `_broker` provider can report which hardware-backed providers are connected and how they are reached. The grammar matrix can adapt descriptions for a client family and locale without changing device code.

Local files under `.mcp-broker/` are useful for deployment-specific descriptions and configuration. They should not hold safety limits that need enforcement. Limits such as maximum velocity, allowed temperature range, permitted work area, or emergency-stop behavior belong in the MHS driver or a policy layer that cannot be bypassed by changing prompt text.

## Safety boundary

Natural-language descriptions are guidance for the model, not a safety mechanism. The component closest to the hardware must reject invalid or unsafe commands deterministically.

For an MHS-backed MCP provider, that means at least:

- reading current device state before executing a state-dependent operation;
- enforcing interlocks independently of the agent;
- distinguishing command acceptance from physical completion;
- returning structured failure information when a device is unavailable or enters a fault state;
- retaining an audit trail that identifies the client, provider, command, parameters, and result.

The broker can contribute identity and routing context, but it cannot certify that a physical action is safe.

## Questions to revisit when MHS is published

The first technical review should answer a short set of concrete questions:

1. Can MHS device capabilities be converted to stable MCP tool and resource schemas without losing constraints?
2. Does MHS define identity and authorization, or must the bridge supply them?
3. Which data stays in the MHS shared state dictionary, and which data should be copied into MCP responses?
4. How are device lifecycle events represented: reconnect, recalibration, degraded mode, emergency stop, and replacement?
5. Does the standard provide version negotiation for drivers and state schemas?
6. Which operations require low-latency paths that should bypass JSON-RPC?

Until those answers are available, the useful work is architectural: preserve the provider boundary, keep transport assumptions out of broker behaviors, and avoid naming an API that may conflict with the eventual MHS specification.
