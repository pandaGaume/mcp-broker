import { bench, describe } from "vitest";
import { LimitPattern, LimitPatternIndex, intersectLimits, compileRegex } from "../src/authority/resource.limits";
import { ResourcePath } from "../src/authorization/resource.path";

const index = new LimitPatternIndex(
    Array.from({ length: 1000 }, (_, i) => new LimitPattern(`/nord/line${i}/valves/{id}`, { minValue: 0, maxValue: 100 }, `declaration:${i}`, { id: "V-\\d{3}" }))
);
const path = ResourcePath.parse("/nord/line500/valves/V-123");
const broad = new LimitPatternIndex(Array.from({ length: 1000 }, (_, i) => new LimitPattern("/nord/valves/{id}", { maxValue: 100 + i }, `declaration:${i}`, { id: "V-\\d{3}" })));
const broadPath = ResourcePath.parse("/nord/valves/V-123");
const vulnerableOrigin = compileRegex("^(https?://)?([a-z]+)+\\.example\\.fr$");
const hostileOrigin = "https://" + "a".repeat(29) + "!.example.fr";

describe("engineering limits, 1000 compiled patterns", () => {
    bench("hostile Origin, nested quantifiers (target: 1 millisecond)", () => {
        vulnerableOrigin.matcher(hostileOrigin).find();
    });
    bench("literal prefix index and intersection (target: 10 microseconds)", () => {
        intersectLimits(index.matching(path).map((p) => ({ limits: p.limits!, source: p.source })));
    });
    bench("1000 overlapping patterns, worst case", () => {
        intersectLimits(broad.matching(broadPath).map((p) => ({ limits: p.limits!, source: p.source })));
    });
});
