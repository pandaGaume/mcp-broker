import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ISSUER = "http://127.0.0.1:4100";
const BROKER_ORIGIN = "http://127.0.0.1:3001";
const CLIENT_ID = "mcp-oauth-lab";
const KEY_ID = "oauth-lab-signing-key";
const IDENTITY_SESSION_COOKIE = "oauth_lab_identity";

const PERSONAS = Object.freeze({
    "la-forge": {
        id: "la-forge",
        name: "Geordi La Forge",
        role: "Chief Engineer",
        sub: "geordi-la-forge",
        groups: ["starfleet-engineering"],
        scopes: ["mcp:call"],
        summary: "Can inspect, diagnose, and reconfigure Area A, except the protected critical furnace.",
    },
    worf: {
        id: "worf",
        name: "Worf",
        role: "Chief Security Officer",
        sub: "worf",
        groups: ["starfleet-security"],
        scopes: ["mcp:call"],
        summary: "Can inspect and operate Area A machines, but cannot perform engineering actions.",
    },
    seven: {
        id: "seven",
        name: "Seven of Nine",
        role: "Astrometrics Specialist",
        sub: "seven-of-nine",
        groups: ["astrometrics"],
        scopes: ["mcp:call"],
        summary: "Has read-only visibility across the Paris site.",
    },
    picard: {
        id: "picard",
        name: "Jean-Luc Picard",
        role: "Captain",
        sub: "jean-luc-picard",
        groups: ["starfleet-command"],
        scopes: ["mcp:call", "broker:admin"],
        summary: "Can access every resource and the reserved broker administration slot.",
    },
});

function writeJson(res, status, body, extraHeaders = {}) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": BROKER_ORIGIN,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        ...extraHeaders,
    });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolveBody, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 64 * 1024) {
                reject(new Error("Request body is too large."));
                req.destroy();
            }
        });
        req.on("end", () => resolveBody(body));
        req.on("error", reject);
    });
}

function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function isAllowedRedirect(value) {
    try {
        const url = new URL(value);
        return url.origin === BROKER_ORIGIN && url.pathname.startsWith("/demos/oauth-lab/");
    } catch {
        return false;
    }
}

function isAllowedResource(value) {
    try {
        const url = new URL(value);
        return url.origin === BROKER_ORIGIN && url.pathname.endsWith("/mcp");
    } catch {
        return false;
    }
}

function readCookie(req, name) {
    const cookieHeader = req.headers.cookie ?? "";
    for (const cookie of cookieHeader.split(";")) {
        const separator = cookie.indexOf("=");
        if (separator < 0) continue;
        if (cookie.slice(0, separator).trim() === name) {
            try {
                return decodeURIComponent(cookie.slice(separator + 1).trim());
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

function identitySessionCookie(sessionId) {
    return `${IDENTITY_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/authorize; Max-Age=3600`;
}

function isValidAuthorizationRequest(params) {
    return (
        params.get("response_type") === "code" &&
        params.get("client_id") === CLIENT_ID &&
        isAllowedRedirect(params.get("redirect_uri") ?? "") &&
        isAllowedResource(params.get("resource") ?? "") &&
        !!params.get("state") &&
        !!params.get("code_challenge") &&
        params.get("code_challenge_method") === "S256"
    );
}

function authorizationPage(params) {
    const hidden = [...params.entries()].map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("");
    const cards = Object.values(PERSONAS)
        .map(
            (persona) => `
                <button class="persona" type="submit" name="persona" value="${persona.id}">
                    <span class="avatar">${persona.name
                        .split(" ")
                        .map((part) => part[0])
                        .join("")
                        .slice(0, 2)}</span>
                    <span class="persona-copy">
                        <strong>${escapeHtml(persona.name)}</strong>
                        <span class="role">${escapeHtml(persona.role)}</span>
                        <span class="summary">${escapeHtml(persona.summary)}</span>
                    </span>
                    <span class="choose">Continue</span>
                </button>`
        )
        .join("");

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in | OAuth Policy Lab</title>
    <style>
        :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; background: #090d13; color: #e8edf5; display: grid; place-items: center; padding: 32px 18px; }
        main { width: min(720px, 100%); }
        .issuer { color: #79a7ff; font: 600 12px ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; }
        h1 { margin: 12px 0 8px; font: 520 clamp(28px, 5vw, 44px) ui-monospace, monospace; letter-spacing: -.04em; }
        .intro { margin: 0 0 28px; color: #99a6b8; line-height: 1.6; }
        .request { margin-bottom: 18px; padding: 12px 14px; border: 1px solid #243044; border-radius: 8px; background: #101722; color: #aab7c9; font: 12px ui-monospace, monospace; overflow-wrap: anywhere; }
        form { display: grid; gap: 10px; }
        .persona { width: 100%; appearance: none; border: 1px solid #253147; border-radius: 10px; background: #101722; color: inherit; padding: 16px; display: grid; grid-template-columns: 44px 1fr auto; gap: 14px; align-items: center; text-align: left; cursor: pointer; transition: border-color .16s, background .16s, transform .16s; }
        .persona:hover, .persona:focus-visible { border-color: #4f87ff; background: #131d2c; transform: translateY(-1px); outline: none; }
        .avatar { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 8px; background: #1d355f; color: #8fb5ff; font: 700 13px ui-monospace, monospace; }
        .persona-copy { display: grid; gap: 2px; }
        strong { font-size: 15px; }
        .role { color: #80aaff; font-size: 12px; }
        .summary { color: #8795a8; font-size: 12px; line-height: 1.45; margin-top: 3px; }
        .choose { color: #8fb5ff; font: 11px ui-monospace, monospace; text-transform: uppercase; letter-spacing: .08em; }
        footer { margin-top: 22px; color: #657286; font: 11px ui-monospace, monospace; line-height: 1.5; }
        @media (max-width: 560px) { .persona { grid-template-columns: 40px 1fr; } .choose { display: none; } }
    </style>
</head>
<body>
    <main>
        <div class="issuer">Local authorization server</div>
        <h1>Choose a demo identity</h1>
        <p class="intro">Each identity receives a signed, audience-bound JWT. The broker will map its claims to subjects and evaluate the same request against different policies.</p>
        <div class="request">resource: ${escapeHtml(params.get("resource") ?? "")}</div>
        <form method="post" action="/authorize/decision">
            ${hidden}
            ${cards}
        </form>
        <footer>Development-only identity provider. No password is requested and no external account is used.</footer>
    </main>
</body>
</html>`;
}

export async function startAuthorizationServer(options = {}) {
    const port = options.port ?? 4100;
    const auditEvents = options.auditEvents ?? [];
    const codes = new Map();
    const identitySessions = new Map();
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const jwks = {
        keys: [
            {
                ...publicJwk,
                kid: KEY_ID,
                alg: "RS256",
                use: "sig",
            },
        ],
    };

    const metadata = {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp:call", "broker:admin"],
    };

    function redirectWithAuthorizationCode(res, params, persona, extraHeaders = {}) {
        const redirectUri = params.get("redirect_uri") ?? "";
        const code = randomUUID();
        codes.set(code, {
            persona,
            clientId: CLIENT_ID,
            redirectUri,
            resource: params.get("resource") ?? "",
            requestedScope: params.get("scope") ?? "",
            codeChallenge: params.get("code_challenge"),
            expiresAt: Date.now() + 2 * 60 * 1000,
        });
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", params.get("state") ?? "");
        res.writeHead(302, {
            Location: redirect.toString(),
            "Cache-Control": "no-store",
            ...extraHeaders,
        });
        res.end();
    }

    function redirectWithAuthorizationError(res, params, error) {
        const redirect = new URL(params.get("redirect_uri") ?? "");
        redirect.searchParams.set("error", error);
        redirect.searchParams.set("state", params.get("state") ?? "");
        res.writeHead(302, {
            Location: redirect.toString(),
            "Cache-Control": "no-store",
        });
        res.end();
    }

    const server = createServer(async (req, res) => {
        const requestUrl = new URL(req.url ?? "/", ISSUER);

        if (req.method === "OPTIONS") {
            writeJson(res, 204, {});
            return;
        }

        if (req.method === "GET" && requestUrl.pathname === "/health") {
            writeJson(res, 200, { status: "ok", issuer: ISSUER });
            return;
        }

        if (req.method === "GET" && (requestUrl.pathname === "/.well-known/oauth-authorization-server" || requestUrl.pathname === "/.well-known/openid-configuration")) {
            writeJson(res, 200, metadata);
            return;
        }

        if (req.method === "GET" && requestUrl.pathname === "/jwks.json") {
            writeJson(res, 200, jwks);
            return;
        }

        if (req.method === "GET" && requestUrl.pathname === "/demo/personas") {
            writeJson(
                res,
                200,
                Object.values(PERSONAS).map(({ sub, groups, scopes, ...persona }) => ({
                    ...persona,
                    subject: sub,
                    groups,
                    scopes,
                }))
            );
            return;
        }

        if (req.method === "GET" && requestUrl.pathname === "/demo/audit") {
            writeJson(res, 200, { events: auditEvents.slice(-80).reverse() });
            return;
        }

        if (req.method === "POST" && requestUrl.pathname === "/demo/audit/clear") {
            auditEvents.splice(0, auditEvents.length);
            writeJson(res, 200, { cleared: true });
            return;
        }

        if (req.method === "GET" && requestUrl.pathname === "/authorize") {
            const params = requestUrl.searchParams;
            if (!isValidAuthorizationRequest(params)) {
                writeJson(res, 400, { error: "invalid_request", error_description: "The demo authorization request is incomplete or invalid." });
                return;
            }
            if (params.get("prompt") === "none") {
                const sessionId = readCookie(req, IDENTITY_SESSION_COOKIE);
                const persona = sessionId ? identitySessions.get(sessionId) : undefined;
                if (!persona) {
                    redirectWithAuthorizationError(res, params, "login_required");
                    return;
                }
                redirectWithAuthorizationCode(res, params, persona);
                return;
            }
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
            });
            res.end(authorizationPage(params));
            return;
        }

        if (req.method === "POST" && requestUrl.pathname === "/authorize/decision") {
            const body = new URLSearchParams(await readBody(req));
            const persona = PERSONAS[body.get("persona")];
            if (!persona || !isValidAuthorizationRequest(body)) {
                writeJson(res, 400, { error: "invalid_request" });
                return;
            }
            const identitySessionId = randomUUID();
            identitySessions.set(identitySessionId, persona);
            redirectWithAuthorizationCode(res, body, persona, {
                "Set-Cookie": identitySessionCookie(identitySessionId),
            });
            return;
        }

        if (req.method === "POST" && requestUrl.pathname === "/token") {
            const body = new URLSearchParams(await readBody(req));
            const code = body.get("code") ?? "";
            const pending = codes.get(code);
            codes.delete(code);
            const verifier = body.get("code_verifier") ?? "";
            const actualChallenge = createHash("sha256").update(verifier).digest("base64url");
            if (
                body.get("grant_type") !== "authorization_code" ||
                body.get("client_id") !== CLIENT_ID ||
                !pending ||
                pending.expiresAt < Date.now() ||
                body.get("redirect_uri") !== pending.redirectUri ||
                body.get("resource") !== pending.resource ||
                actualChallenge !== pending.codeChallenge
            ) {
                writeJson(res, 400, {
                    error: "invalid_grant",
                    error_description: "The authorization code or PKCE verifier is invalid.",
                });
                return;
            }

            const requested = new Set(pending.requestedScope.split(/\s+/).filter(Boolean));
            const grantedScopes = pending.persona.scopes.filter((scope) => requested.has(scope));
            const now = Math.floor(Date.now() / 1000);
            const accessToken = await new SignJWT({
                groups: pending.persona.groups,
                scope: grantedScopes.join(" "),
                client_id: CLIENT_ID,
                name: pending.persona.name,
                demo_persona: pending.persona.id,
            })
                .setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "at+jwt" })
                .setIssuer(ISSUER)
                .setSubject(pending.persona.sub)
                .setAudience(pending.resource)
                .setIssuedAt(now)
                .setExpirationTime(now + 15 * 60)
                .setJti(randomUUID())
                .sign(privateKey);

            writeJson(res, 200, {
                access_token: accessToken,
                token_type: "Bearer",
                expires_in: 900,
                scope: grantedScopes.join(" "),
            });
            return;
        }

        writeJson(res, 404, { error: "not_found" });
    });

    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolveListen();
        });
    });

    return {
        server,
        issuer: ISSUER,
        close: () =>
            new Promise((resolveClose, reject) => {
                server.close((error) => (error ? reject(error) : resolveClose()));
            }),
    };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const instance = await startAuthorizationServer();
    process.stdout.write(`[oauth-lab] authorization server listening at ${instance.issuer}\n`);
}
