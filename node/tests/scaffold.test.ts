import { describe, it, expect } from "vitest";
import { WsTunnelBuilder } from "../src/index.js";

describe("WsTunnelBuilder", () => {
    it("builds a tunnel without throwing", () => {
        const tunnel = new WsTunnelBuilder().withPort(0).build();
        expect(tunnel.isListening).toBe(false);
    });

    it("does not list any provider before start", () => {
        const tunnel = new WsTunnelBuilder().withPort(0).build();
        expect(tunnel.providerNames.length).toBe(0);
        expect(tunnel.clientCount).toBe(0);
    });
});
