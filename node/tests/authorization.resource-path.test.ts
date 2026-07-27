import { describe, expect, it } from "vitest";
import { ResourcePath, ResourcePathPattern } from "../src/index.js";

describe("ResourcePath", () => {
    it("normalizes a trailing slash deterministically", () => {
        expect(ResourcePath.parse("/enterprise/site/").value).toBe("/enterprise/site");
    });

    it("supports the root path", () => {
        expect(ResourcePath.parse("/").segments).toEqual([]);
        expect(ResourcePathPattern.parse("/").matches(ResourcePath.parse("/"))).toBe(true);
        expect(ResourcePathPattern.parse("/").matches(ResourcePath.parse("/site"))).toBe(false);
    });

    it.each(["site", "/site//asset", "/site/./asset", "/site/../asset", "/site/*"])("rejects malformed or unsafe path %s", (value) => {
        expect(() => ResourcePath.parse(value)).toThrow();
    });
});

describe("ResourcePathPattern", () => {
    const asset = ResourcePath.parse("/enterprise/site/area/asset-1");

    it("matches exact paths only", () => {
        const pattern = ResourcePathPattern.parse("/enterprise/site/area/asset-1");
        expect(pattern.matches(asset)).toBe(true);
        expect(pattern.matches(ResourcePath.parse("/enterprise/site/area/asset-2"))).toBe(false);
        expect(pattern.matches(ResourcePath.parse("/enterprise/Site/area/asset-1"))).toBe(false);
    });

    it("matches exactly one segment with *", () => {
        const pattern = ResourcePathPattern.parse("/enterprise/site/*");
        expect(pattern.matches(ResourcePath.parse("/enterprise/site/area"))).toBe(true);
        expect(pattern.matches(asset)).toBe(false);
        expect(pattern.matches(ResourcePath.parse("/enterprise/site"))).toBe(false);
    });

    it("matches a parent and all descendants with a final **", () => {
        const pattern = ResourcePathPattern.parse("/enterprise/site/**");
        expect(pattern.matches(ResourcePath.parse("/enterprise/site"))).toBe(true);
        expect(pattern.matches(asset)).toBe(true);
        expect(pattern.matches(ResourcePath.parse("/enterprise/sibling"))).toBe(false);
    });

    it("supports the legacy ** shorthand as every absolute resource", () => {
        expect(ResourcePathPattern.parse("**").matches(ResourcePath.parse("/"))).toBe(true);
        expect(ResourcePathPattern.parse("**").matches(asset)).toBe(true);
    });

    it.each(["/site/**/asset", "/site/a*", "/site/../**"])("rejects malformed pattern %s", (value) => {
        expect(() => ResourcePathPattern.parse(value)).toThrow();
    });
});
