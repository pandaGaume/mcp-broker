import { WebSocket } from "ws";

// Vitest runs this before each test file, including new provider integration tests.
if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
}
