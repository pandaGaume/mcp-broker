import { createHash, randomBytes } from "node:crypto";

const BROKER = "http://127.0.0.1:3001";
const ISSUER = "http://127.0.0.1:4100";
const CLIENT_ID = "mcp-oauth-lab";
const REDIRECT_URI = `${BROKER}/demos/oauth-lab/`;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function json(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let body = text;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        // Keep text responses unchanged.
    }
    return { response, body };
}

async function grantFor({ persona, slot, identityCookie }) {
    const resource = `${BROKER}/${slot}/mcp`;
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    const request = {
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: "mcp:call broker:admin",
        resource,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: persona ? "select_account" : "none",
    };

    const authorizeUrl = new URL(`${ISSUER}/authorize`);
    for (const [name, value] of Object.entries(request)) authorizeUrl.searchParams.set(name, value);
    const authorize = await fetch(authorizeUrl, {
        redirect: "manual",
        headers: identityCookie ? { Cookie: identityCookie } : {},
    });

    let location;
    if (persona) {
        assert(authorize.status === 200, `Authorization page failed with HTTP ${authorize.status}.`);
        const decision = await fetch(`${ISSUER}/authorize/decision`, {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ ...request, persona }),
        });
        assert(decision.status === 302, `Authorization decision failed with HTTP ${decision.status}.`);
        location = decision.headers.get("location");
        const setCookie = decision.headers.get("set-cookie");
        assert(setCookie, "Interactive authorization created no identity session.");
        identityCookie = setCookie.split(";", 1)[0];
    } else {
        assert(authorize.status === 302, `Silent authorization returned HTTP ${authorize.status} instead of redirecting.`);
        location = authorize.headers.get("location");
    }

    assert(location, "Authorization response has no redirect location.");
    const callback = new URL(location);
    assert(callback.searchParams.get("state") === state, "OAuth state was not preserved.");
    assert(!callback.searchParams.get("error"), `Authorization failed with ${callback.searchParams.get("error")}.`);
    const code = callback.searchParams.get("code");
    assert(code, "Authorization response has no code.");

    const exchanged = await json(`${ISSUER}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
            resource,
        }),
    });
    assert(exchanged.response.ok, `Token exchange failed with HTTP ${exchanged.response.status}.`);
    assert(exchanged.body.access_token, "Token response has no access token.");
    return {
        accessToken: exchanged.body.access_token,
        identityCookie,
    };
}

async function tokenFor(persona, slot) {
    return (await grantFor({ persona, slot })).accessToken;
}

async function rpc(slot, accessToken, method, params = {}) {
    return json(`${BROKER}/${slot}/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: Math.floor(Date.now() + Math.random() * 1000),
            method,
            params,
        }),
    });
}

function expectHttp(result, status, label) {
    assert(result.response.status === status, `${label}: expected HTTP ${status}, got ${result.response.status}.`);
}

const metadata = await json(`${BROKER}/.well-known/oauth-protected-resource/motor-7/mcp`);
expectHttp(metadata, 200, "protected resource metadata");
assert(metadata.body.resource === `${BROKER}/motor-7/mcp`, "Protected resource metadata has the wrong resource.");

const unauthenticated = await rpc("motor-7", null, "tools/list");
expectHttp(unauthenticated, 401, "missing bearer token");
assert(unauthenticated.response.headers.get("www-authenticate")?.includes("resource_metadata="), "401 challenge has no resource metadata URL.");

const laForgeMotor = await tokenFor("la-forge", "motor-7");
expectHttp(await rpc("motor-7", laForgeMotor, "tools/list"), 200, "Geordi tools/list");
expectHttp(
    await rpc("motor-7", laForgeMotor, "tools/call", {
        name: "diagnose_machine",
        arguments: { depth: "full" },
    }),
    200,
    "Geordi diagnostic"
);
expectHttp(
    await rpc("motor-7", laForgeMotor, "tools/call", {
        name: "start_machine",
        arguments: { confirmation: true },
    }),
    403,
    "Geordi operational denial"
);
expectHttp(await rpc("critical-furnace", laForgeMotor, "tools/list"), 401, "wrong audience");

const laForgeFurnace = await tokenFor("la-forge", "critical-furnace");
expectHttp(
    await rpc("critical-furnace", laForgeFurnace, "tools/call", {
        name: "reset_baseline",
        arguments: { reason: "smoke test" },
    }),
    403,
    "critical furnace explicit deny"
);

const worfMotor = await tokenFor("worf", "motor-7");
expectHttp(
    await rpc("motor-7", worfMotor, "tools/call", {
        name: "start_machine",
        arguments: { confirmation: true },
    }),
    200,
    "Worf operational grant"
);

const sevenEnergy = await tokenFor("seven", "site-energy");
expectHttp(
    await rpc("site-energy", sevenEnergy, "tools/call", {
        name: "get_electrical_state",
        arguments: {},
    }),
    200,
    "Seven of Nine read grant"
);
expectHttp(
    await rpc("site-energy", sevenEnergy, "tools/call", {
        name: "reset_baseline",
        arguments: { reason: "smoke test" },
    }),
    403,
    "Seven of Nine mutation denial"
);

const laForgeBroker = await tokenFor("la-forge", "_broker");
expectHttp(await rpc("_broker", laForgeBroker, "tools/list"), 403, "per-slot admin scope");

const picardBrokerGrant = await grantFor({ persona: "picard", slot: "_broker" });
const picardBroker = picardBrokerGrant.accessToken;
expectHttp(await rpc("_broker", picardBroker, "tools/list"), 200, "captain broker access");

const picardMotorGrant = await grantFor({
    slot: "motor-7",
    identityCookie: picardBrokerGrant.identityCookie,
});
const picardMotor = picardMotorGrant.accessToken;
expectHttp(
    await rpc("motor-7", picardMotor, "tools/call", {
        name: "diagnose_machine",
        arguments: { depth: "full" },
    }),
    200,
    "Picard motor access"
);

const picardFurnaceGrant = await grantFor({
    slot: "critical-furnace",
    identityCookie: picardBrokerGrant.identityCookie,
});
const picardFurnace = picardFurnaceGrant.accessToken;
expectHttp(
    await rpc("critical-furnace", picardFurnace, "tools/call", {
        name: "reset_baseline",
        arguments: { reason: "captain authorization test" },
    }),
    200,
    "Picard critical furnace access"
);

const picardEnergyGrant = await grantFor({
    slot: "site-energy",
    identityCookie: picardBrokerGrant.identityCookie,
});
const picardEnergy = picardEnergyGrant.accessToken;
expectHttp(
    await rpc("site-energy", picardEnergy, "tools/call", {
        name: "get_electrical_state",
        arguments: {},
    }),
    200,
    "Picard site energy access"
);

await new Promise((resolveWait) => setTimeout(resolveWait, 150));
const audit = await json(`${ISSUER}/demo/audit`);
expectHttp(audit, 200, "audit endpoint");
assert(
    audit.body.events.some((event) => event.allowed === true),
    "Audit contains no allowed event."
);
assert(
    audit.body.events.some((event) => event.reason === "explicit-deny"),
    "Audit contains no explicit deny event."
);
assert(
    audit.body.events.some((event) => event.reason === "no-matching-grant"),
    "Audit contains no missing grant event."
);

process.stdout.write(
    JSON.stringify(
        {
            ok: true,
            checks: 19,
            silentTokenAdditions: 3,
            auditEvents: audit.body.events.length,
        },
        null,
        2
    ) + "\n"
);
