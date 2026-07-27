const AUTHORIZATION_SERVER = "http://127.0.0.1:4100";
const BROKER_ORIGIN = "http://127.0.0.1:3001";
const CLIENT_ID = "mcp-oauth-lab";
const TOKEN_CACHE_KEY = "mcp-oauth-lab:token-cache";
const LEGACY_SESSION_KEY = "mcp-oauth-lab:session";
const PENDING_KEY = "mcp-oauth-lab:pending";
const SELECTED_SLOT_KEY = "mcp-oauth-lab:selected-slot";

const state = {
    slot: sessionStorage.getItem(SELECTED_SLOT_KEY) ?? "motor-7",
    metadata: null,
    authorizationMetadata: null,
    tokenCache: readStoredTokenCache(),
    session: null,
    initialized: new Set(),
    auditFingerprint: "",
};

const elements = {
    brokerStatus: document.getElementById("broker-status"),
    issuerStatus: document.getElementById("issuer-status"),
    discoverButton: document.getElementById("discover-btn"),
    metadataCard: document.getElementById("metadata-card"),
    signInButton: document.getElementById("sign-in-btn"),
    signOutButton: document.getElementById("sign-out-btn"),
    reauthorizeButton: document.getElementById("reauthorize-btn"),
    audienceNotice: document.getElementById("audience-notice"),
    audienceNoticeCopy: document.getElementById("audience-notice-copy"),
    sessionEmpty: document.getElementById("session-empty"),
    sessionActive: document.getElementById("session-active"),
    identityAvatar: document.getElementById("identity-avatar"),
    identityName: document.getElementById("identity-name"),
    identitySubject: document.getElementById("identity-subject"),
    claimAudience: document.getElementById("claim-aud"),
    claimGroups: document.getElementById("claim-groups"),
    claimScope: document.getElementById("claim-scope"),
    claimExpiration: document.getElementById("claim-exp"),
    cacheSummary: document.getElementById("cache-summary"),
    claimsOutput: document.getElementById("claims-output"),
    targetSlot: document.getElementById("target-slot"),
    requestOutput: document.getElementById("request-output"),
    responseOutput: document.getElementById("response-output"),
    consoleStatus: document.getElementById("console-status"),
    consoleDuration: document.getElementById("console-duration"),
    consoleDot: document.getElementById("console-dot"),
    auditList: document.getElementById("audit-list"),
    auditCount: document.getElementById("audit-count"),
    clearAuditButton: document.getElementById("clear-audit-btn"),
    toast: document.getElementById("toast"),
};

function isUsableSession(value) {
    return !!value?.accessToken && !!value?.claims && typeof value.resource === "string" && (typeof value.claims.exp !== "number" || value.claims.exp * 1000 > Date.now());
}

function readStoredTokenCache() {
    const usable = {};
    try {
        const stored = JSON.parse(sessionStorage.getItem(TOKEN_CACHE_KEY) ?? "{}");
        for (const value of Object.values(stored ?? {})) {
            if (isUsableSession(value)) usable[value.resource] = value;
        }
    } catch {
        sessionStorage.removeItem(TOKEN_CACHE_KEY);
    }

    try {
        const legacy = JSON.parse(sessionStorage.getItem(LEGACY_SESSION_KEY) ?? "null");
        if (isUsableSession(legacy)) usable[legacy.resource] = legacy;
    } catch {
        // Ignore invalid data from the previous single-token implementation.
    } finally {
        sessionStorage.removeItem(LEGACY_SESSION_KEY);
    }

    if (Object.keys(usable).length > 0) sessionStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(usable));
    return usable;
}

function selectedSlot() {
    return document.querySelector('input[name="slot"]:checked')?.value ?? state.slot;
}

function metadataUrl(slot) {
    return `${window.location.origin}/.well-known/oauth-protected-resource/${encodeURIComponent(slot)}/mcp`;
}

function resourceUrl(slot) {
    return `${window.location.origin}/${encodeURIComponent(slot)}/mcp`;
}

function cachedSession(slot) {
    return state.tokenCache[resourceUrl(slot)] ?? null;
}

function cachedSessions() {
    return Object.values(state.tokenCache);
}

function syncActiveSession() {
    state.session = cachedSession(selectedSlot()) ?? cachedSessions()[0] ?? null;
}

function persistTokenCache() {
    if (cachedSessions().length === 0) {
        sessionStorage.removeItem(TOKEN_CACHE_KEY);
        return;
    }
    sessionStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(state.tokenCache));
}

function tokenPreview(token) {
    return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomBase64Url(length = 32) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
}

async function sha256Base64Url(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return base64Url(new Uint8Array(digest));
}

function decodeJwt(token) {
    const payload = token.split(".")[1];
    if (!payload) throw new Error("The access token is not a JWT.");
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))));
}

function initials(name) {
    return String(name ?? "?")
        .split(/\s+/u)
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
}

function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => elements.toast.classList.remove("show"), 3000);
}

function setServiceStatus(element, online, title) {
    element.classList.remove("checking", "online", "offline");
    element.classList.add(online ? "online" : "offline");
    element.title = title;
}

async function checkServices() {
    const checks = await Promise.allSettled([fetch(window.location.origin, { cache: "no-store" }), fetch(`${AUTHORIZATION_SERVER}/health`, { cache: "no-store" })]);
    const brokerOnline = window.location.origin === BROKER_ORIGIN && checks[0].status === "fulfilled" && checks[0].value.ok;
    const issuerOnline = checks[1].status === "fulfilled" && checks[1].value.ok;
    setServiceStatus(elements.brokerStatus, brokerOnline, brokerOnline ? "Broker online" : "Start this page with npm run demo:oauth");
    setServiceStatus(elements.issuerStatus, issuerOnline, issuerOnline ? "Authorization server online" : "Authorization server unavailable");
}

async function discover() {
    elements.discoverButton.disabled = true;
    elements.discoverButton.textContent = "Loading";
    try {
        const slot = selectedSlot();
        const response = await fetch(metadataUrl(slot), { cache: "no-store" });
        if (!response.ok) throw new Error(`Metadata request returned HTTP ${response.status}.`);
        const metadata = await response.json();
        const issuer = metadata.authorization_servers?.[0];
        if (!issuer) throw new Error("The metadata does not advertise an authorization server.");
        const authorizationResponse = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { cache: "no-store" });
        if (!authorizationResponse.ok) throw new Error(`Authorization metadata returned HTTP ${authorizationResponse.status}.`);
        state.metadata = metadata;
        state.authorizationMetadata = await authorizationResponse.json();
        elements.metadataCard.innerHTML = `
            <dl class="metadata-values">
                <div><dt>resource</dt><dd>${escapeHtml(metadata.resource)}</dd></div>
                <div><dt>issuer</dt><dd>${escapeHtml(issuer)}</dd></div>
                <div><dt>scopes</dt><dd>${escapeHtml((metadata.scopes_supported ?? []).join(" "))}</dd></div>
                <div><dt>bearer</dt><dd>${escapeHtml((metadata.bearer_methods_supported ?? []).join(", "))}</dd></div>
            </dl>`;
        document.getElementById("flow-discovery").classList.add("complete");
        showToast("Protected resource discovered");
        return metadata;
    } catch (error) {
        elements.metadataCard.innerHTML = `
            <div class="metadata-empty">
                <span class="metadata-mark">!</span>
                <p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
            </div>`;
        throw error;
    } finally {
        elements.discoverButton.disabled = false;
        elements.discoverButton.textContent = "Discover";
    }
}

async function beginAuthorization(silent = cachedSessions().length > 0) {
    elements.signInButton.disabled = true;
    elements.reauthorizeButton.disabled = true;
    try {
        const metadata = state.metadata?.resource === resourceUrl(selectedSlot()) ? state.metadata : await discover();
        const verifier = randomBase64Url(48);
        const challenge = await sha256Base64Url(verifier);
        const oauthState = randomBase64Url(24);
        const redirectUri = `${window.location.origin}${window.location.pathname}`;
        const pending = {
            verifier,
            state: oauthState,
            redirectUri,
            resource: metadata.resource,
            slot: selectedSlot(),
            tokenEndpoint: state.authorizationMetadata.token_endpoint,
            createdAt: Date.now(),
            silent,
        };
        sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
        const authorizationUrl = new URL(state.authorizationMetadata.authorization_endpoint);
        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("client_id", CLIENT_ID);
        authorizationUrl.searchParams.set("redirect_uri", redirectUri);
        authorizationUrl.searchParams.set("scope", "mcp:call broker:admin");
        authorizationUrl.searchParams.set("resource", metadata.resource);
        authorizationUrl.searchParams.set("state", oauthState);
        authorizationUrl.searchParams.set("code_challenge", challenge);
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
        authorizationUrl.searchParams.set("prompt", silent ? "none" : "select_account");
        document.getElementById("flow-login").classList.add("complete");
        window.location.assign(authorizationUrl);
    } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
        elements.signInButton.disabled = false;
        elements.reauthorizeButton.disabled = false;
    }
}

async function completeAuthorization() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    const returnedState = url.searchParams.get("state");
    if (!code && !oauthError) return;

    let pending;
    try {
        pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
    } catch {
        pending = null;
    }
    if (!pending || returnedState !== pending.state || Date.now() - pending.createdAt > 5 * 60 * 1000) {
        throw new Error("OAuth state validation failed. Start the sign-in flow again.");
    }
    if (oauthError) {
        sessionStorage.removeItem(PENDING_KEY);
        window.history.replaceState({}, "", window.location.pathname);
        if (oauthError === "login_required" && pending.silent) {
            showToast("Identity session expired. Choose the identity again.");
            await beginAuthorization(false);
            return;
        }
        throw new Error(`OAuth authorization failed: ${oauthError}.`);
    }

    const tokenResponse = await fetch(pending.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: CLIENT_ID,
            redirect_uri: pending.redirectUri,
            code_verifier: pending.verifier,
            resource: pending.resource,
        }),
    });
    const tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenBody.access_token) {
        throw new Error(tokenBody.error_description ?? tokenBody.error ?? "Token exchange failed.");
    }
    const claims = decodeJwt(tokenBody.access_token);
    const session = {
        accessToken: tokenBody.access_token,
        claims,
        scope: tokenBody.scope ?? "",
        resource: pending.resource,
        slot: pending.slot,
    };
    const cachedPersona = cachedSessions()[0]?.claims?.demo_persona;
    if (cachedPersona && cachedPersona !== claims.demo_persona) {
        state.tokenCache = {};
        state.initialized.clear();
    }
    state.tokenCache[pending.resource] = session;
    state.slot = pending.slot;
    persistTokenCache();
    syncActiveSession();
    sessionStorage.setItem(SELECTED_SLOT_KEY, state.slot);
    sessionStorage.removeItem(PENDING_KEY);
    window.history.replaceState({}, "", window.location.pathname);
    document.getElementById("flow-login").classList.add("complete");
    document.getElementById("flow-token").classList.add("complete");
    showToast(`Token ${tokenPreview(tokenBody.access_token)} added to cache for ${pending.slot}`);
}

function clearTokenCache() {
    state.tokenCache = {};
    state.session = null;
    state.initialized.clear();
    sessionStorage.removeItem(TOKEN_CACHE_KEY);
    sessionStorage.removeItem(LEGACY_SESSION_KEY);
    renderSession();
    renderExpectations();
    showToast("Token cache cleared");
}

function renderSession() {
    const session = state.session;
    elements.sessionEmpty.classList.toggle("hidden", !!session);
    elements.sessionActive.classList.toggle("hidden", !session);
    elements.signOutButton.classList.toggle("hidden", !session);
    if (!session) {
        document.getElementById("flow-token").classList.remove("complete");
        return;
    }

    const claims = session.claims;
    elements.identityAvatar.textContent = initials(claims.name ?? claims.sub);
    elements.identityName.textContent = claims.name ?? claims.sub ?? "Unknown subject";
    elements.identitySubject.textContent = `user:${claims.sub ?? "unknown"} | client:${claims.client_id ?? "unknown"}`;
    elements.claimAudience.textContent = Array.isArray(claims.aud) ? claims.aud.join(", ") : (claims.aud ?? "");
    elements.claimGroups.textContent = Array.isArray(claims.groups) ? claims.groups.join(", ") : (claims.groups ?? "");
    elements.claimScope.textContent = claims.scope ?? "";
    elements.claimExpiration.textContent = typeof claims.exp === "number" ? new Date(claims.exp * 1000).toLocaleTimeString() : "unknown";
    elements.cacheSummary.textContent = `${cachedSessions().length} of 4 resource tokens`;
    elements.claimsOutput.textContent = JSON.stringify(claims, null, 2);
    renderAudienceState();
    document.getElementById("flow-login").classList.add("complete");
    document.getElementById("flow-token").classList.add("complete");
}

function renderAudienceState() {
    const pill = document.querySelector(".token-valid");
    if (!pill || !state.session) return;
    const matches = !!cachedSession(selectedSlot());
    pill.textContent = matches ? "cache hit" : "token missing";
    pill.classList.toggle("mismatch", !matches);
    elements.audienceNotice.classList.toggle("hidden", matches);
    elements.reauthorizeButton.disabled = false;
    if (!matches) {
        const identity = state.session.claims?.name ?? state.session.claims?.sub ?? "This identity";
        elements.audienceNoticeCopy.textContent = `No token is cached for ${selectedSlot()}. The authorization server can add one silently for ${identity}, without showing the identity page again.`;
        elements.reauthorizeButton.textContent = `Add ${selectedSlot()} token to cache`;
    }
}

function expected(action) {
    if (action === "unauthenticated" || action === "wrong-audience") return { allowed: false, label: "expect 401" };
    const slot = selectedSlot();
    const session = cachedSession(slot);
    const persona = session?.claims?.demo_persona;
    if (!persona) return { allowed: null, label: cachedSessions().length > 0 ? "cache token first" : "sign in first" };
    if (slot === "_broker") {
        return persona === "picard" ? { allowed: true, label: "expect allow" } : { allowed: false, label: "expect scope 403" };
    }
    if (persona === "picard") return { allowed: true, label: "expect allow" };
    if (persona === "seven") {
        return ["list", "read"].includes(action) ? { allowed: true, label: "expect allow" } : { allowed: false, label: "expect policy 403" };
    }
    if (slot === "site-energy") return { allowed: false, label: "expect policy 403" };
    if (persona === "la-forge") {
        const allowed = ["list", "read", "diagnose"].includes(action) || (action === "reset" && slot !== "critical-furnace");
        const explicit = action === "reset" && slot === "critical-furnace";
        return { allowed, label: allowed ? "expect allow" : explicit ? "explicit deny 403" : "expect policy 403" };
    }
    if (persona === "worf") {
        const allowed = ["list", "read", "start"].includes(action);
        return { allowed, label: allowed ? "expect allow" : "expect policy 403" };
    }
    return { allowed: false, label: "expect policy 403" };
}

function renderExpectations() {
    for (const element of document.querySelectorAll("[data-expect]")) {
        const result = expected(element.dataset.expect);
        element.textContent = result.label;
        element.classList.toggle("allow", result.allowed === true);
        element.classList.toggle("deny", result.allowed === false);
    }
}

function requestForAction(action) {
    if (action === "list" || action === "unauthenticated" || action === "wrong-audience") {
        return { method: "tools/list", params: {} };
    }
    if (action === "read") {
        return { method: "tools/call", params: { name: "get_electrical_state", arguments: {} } };
    }
    if (action === "diagnose") {
        return { method: "tools/call", params: { name: "diagnose_machine", arguments: { depth: "full" } } };
    }
    if (action === "reset") {
        return {
            method: "tools/call",
            params: { name: "reset_baseline", arguments: { reason: "OAuth Policy Lab demonstration" } },
        };
    }
    if (action === "start") {
        return { method: "tools/call", params: { name: "start_machine", arguments: { confirmation: true } } };
    }
    return { method: "tools/list", params: {} };
}

async function sendRpc(slot, method, params, accessToken) {
    const id = Math.floor(Date.now() + Math.random() * 1000);
    const message = { jsonrpc: "2.0", id, method, params };
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const startedAt = performance.now();
    const response = await fetch(resourceUrl(slot), {
        method: "POST",
        headers,
        body: JSON.stringify(message),
    });
    const text = await response.text();
    let body = text;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        // Keep non-JSON responses as text.
    }
    return {
        request: {
            url: resourceUrl(slot),
            authorization: accessToken ? "Bearer [redacted]" : "(none)",
            body: message,
        },
        response: {
            status: response.status,
            wwwAuthenticate: response.headers.get("www-authenticate"),
            body,
        },
        duration: performance.now() - startedAt,
    };
}

async function ensureInitialized(slot, accessToken, claims) {
    const key = `${slot}:${claims?.jti ?? "anonymous"}`;
    if (state.initialized.has(key)) return;
    const initialized = await sendRpc(
        slot,
        "initialize",
        {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "oauth-policy-lab", version: "1.0.0" },
        },
        accessToken
    );
    if (initialized.response.status >= 400 || initialized.response.body?.error) return;
    await sendRpc(slot, "notifications/initialized", {}, accessToken);
    state.initialized.add(key);
}

function alternateSlot(slot) {
    const slots = ["motor-7", "critical-furnace", "site-energy", "_broker"];
    return slots.find((candidate) => candidate !== slot) ?? "motor-7";
}

function setConsole(result, label) {
    const successful = result.response.status < 400 && !result.response.body?.error;
    elements.consoleStatus.textContent = `${label} | HTTP ${result.response.status}`;
    elements.consoleDuration.textContent = `${Math.round(result.duration)} ms`;
    elements.consoleDot.classList.toggle("success", successful);
    elements.consoleDot.classList.toggle("failure", !successful);
    elements.requestOutput.textContent = JSON.stringify(result.request, null, 2);
    elements.responseOutput.textContent = JSON.stringify(result.response, null, 2);
    if (result.response.status === 401 || result.response.status === 403) {
        elements.responseOutput.scrollTop = 0;
    }
}

async function runAction(action, button) {
    const selected = selectedSlot();
    const session = action === "wrong-audience" ? state.session : cachedSession(selected);
    if (!session && action !== "unauthenticated") {
        showToast(cachedSessions().length > 0 ? `Add a token to the cache for ${selected}` : "Sign in before running this action");
        return;
    }

    button.disabled = true;
    const target = action === "wrong-audience" ? alternateSlot(session?.slot ?? selected) : selected;
    const accessToken = action === "unauthenticated" ? null : session?.accessToken;
    const request = requestForAction(action);
    try {
        if (accessToken && action !== "wrong-audience") {
            await ensureInitialized(target, accessToken, session?.claims);
        }
        const result = await sendRpc(target, request.method, request.params, accessToken);
        setConsole(result, action);
        if (accessToken && action !== "wrong-audience") {
            document.getElementById("flow-policy").classList.add("complete");
        }
        await refreshAudit();
    } catch (error) {
        elements.consoleStatus.textContent = "Request failed";
        elements.consoleDuration.textContent = "";
        elements.consoleDot.classList.remove("success");
        elements.consoleDot.classList.add("failure");
        elements.responseOutput.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
    } finally {
        button.disabled = false;
    }
}

function renderAudit(events) {
    const fingerprint = JSON.stringify(events);
    if (fingerprint === state.auditFingerprint) return;
    state.auditFingerprint = fingerprint;
    elements.auditCount.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
    if (events.length === 0) {
        elements.auditList.innerHTML = '<div class="audit-empty">Run an authenticated MCP action to generate the first decision.</div>';
        return;
    }
    elements.auditList.innerHTML = events
        .map(
            (event) => `
                <div class="audit-event ${event.allowed ? "" : "denied"}">
                    <span class="audit-time">${escapeHtml(new Date(event.timestamp).toLocaleTimeString())}</span>
                    <span class="decision">${event.allowed ? "allowed" : "denied"}</span>
                    <span class="audit-capability">${escapeHtml(event.capability ?? "(unclassified)")}</span>
                    <span class="audit-resource" title="${escapeHtml(event.resource ?? event.slot)}">${escapeHtml(event.resource ?? event.slot)}</span>
                    <span class="audit-reason">${escapeHtml(event.reason)}</span>
                </div>`
        )
        .join("");
}

async function refreshAudit() {
    try {
        const response = await fetch(`${AUTHORIZATION_SERVER}/demo/audit`, { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json();
        renderAudit(body.events ?? []);
    } catch {
        // Audit is auxiliary; service status reports an unavailable issuer.
    }
}

async function clearAudit() {
    await fetch(`${AUTHORIZATION_SERVER}/demo/audit/clear`, { method: "POST" });
    state.auditFingerprint = "";
    await refreshAudit();
    showToast("Audit log cleared");
}

function applySelectedSlot() {
    const input = document.querySelector(`input[name="slot"][value="${CSS.escape(state.slot)}"]`);
    if (input) input.checked = true;
    elements.targetSlot.textContent = selectedSlot();
    renderExpectations();
}

for (const input of document.querySelectorAll('input[name="slot"]')) {
    input.addEventListener("change", () => {
        state.slot = selectedSlot();
        state.metadata = null;
        state.authorizationMetadata = null;
        sessionStorage.setItem(SELECTED_SLOT_KEY, state.slot);
        elements.targetSlot.textContent = state.slot;
        elements.metadataCard.innerHTML = `
            <div class="metadata-empty">
                <span class="metadata-mark">?</span>
                <p>Run discovery to load RFC 9728 metadata without a token.</p>
            </div>`;
        document.getElementById("flow-discovery").classList.remove("complete");
        syncActiveSession();
        renderSession();
        renderExpectations();
    });
}

elements.discoverButton.addEventListener("click", () => {
    void discover().catch((error) => showToast(error instanceof Error ? error.message : String(error)));
});
elements.signInButton.addEventListener("click", () => void beginAuthorization(false));
elements.reauthorizeButton.addEventListener("click", () => void beginAuthorization(true));
elements.signOutButton.addEventListener("click", clearTokenCache);
elements.clearAuditButton.addEventListener("click", () => void clearAudit());

for (const button of document.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => void runAction(button.dataset.action, button));
}

async function initializePage() {
    applySelectedSlot();
    try {
        await completeAuthorization();
    } catch (error) {
        sessionStorage.removeItem(PENDING_KEY);
        window.history.replaceState({}, "", window.location.pathname);
        showToast(error instanceof Error ? error.message : String(error));
    }
    applySelectedSlot();
    syncActiveSession();
    renderSession();
    renderExpectations();
    await Promise.all([checkServices(), refreshAudit()]);
    window.setInterval(() => void refreshAudit(), 1500);
    window.setInterval(() => void checkServices(), 10000);
}

void initializePage();
