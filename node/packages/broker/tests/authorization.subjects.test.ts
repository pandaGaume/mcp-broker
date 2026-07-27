import { describe, expect, it } from "vitest";
import { JwtSubjectMapper, SubjectMappingError } from "../src/index";

describe("JwtSubjectMapper", () => {
    const mapper = new JwtSubjectMapper({
        userClaim: "sub",
        groupClaims: ["groups", "realm.roles"],
        clientClaim: "client_id",
    });

    it("maps string and string-array claims and removes duplicate subjects", () => {
        const subject = mapper.map({
            sub: "alice",
            groups: ["maintenance", "maintenance"],
            realm: { roles: "employees" },
            client_id: "assistant",
        });
        expect(subject.ids).toEqual(["user:alice", "group:maintenance", "group:employees", "client:assistant"]);
    });

    it("ignores missing optional claims", () => {
        expect(mapper.map({ sub: "alice" }).ids).toEqual(["user:alice"]);
        expect(mapper.map({}).ids).toEqual([]);
    });

    it("fails safely on malformed configured claims", () => {
        expect(() => mapper.map({ sub: "alice", groups: { name: "maintenance" } })).toThrow(SubjectMappingError);
        expect(() => mapper.map({ sub: "alice", groups: ["ok", 42] })).toThrow(SubjectMappingError);
    });
});
