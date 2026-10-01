// ============================================================
// CreatorBlock background script
//
// The only place that talks to the CreatorBlock server. The page
// scripts and the popup send it messages instead, so YouTube's own
// page rules can never get in the way.
// ============================================================

// Your server address lives in config.js. Chrome loads this file as a
// service worker, where importScripts() works. Firefox instead loads
// config.js and background.js as separate ordinary scripts (see the
// "scripts" array in manifest.json) - importScripts doesn't exist
// there, so this only runs on Chrome/Chromium.
if (typeof importScripts === "function") {
    importScripts("config.js");
}

// Same shim as shared.js - see the comment there. background.js is a
// separate script world that never loads shared.js, so it needs its
// own copy.
if (typeof browser === "undefined") {
    var browser = chrome;
}


// ---------- anonymous user ID ----------
// A random number made once on this computer. The server only ever
// sees a scrambled version of it, and uses it to stop double voting
// and to remember which channels you have proven you own.

const USER_ID_KEY = "creatorblock_user_id";
let userIdPromise = null;

function getUserId() {
    if (!userIdPromise) {
        userIdPromise = (async () => {
            const data = await browser.storage.local.get(USER_ID_KEY);

            if (data[USER_ID_KEY]) {
                return data[USER_ID_KEY];
            }

            const bytes = crypto.getRandomValues(new Uint8Array(16));
            const id = Array.from(bytes, (byte) =>
                byte.toString(16).padStart(2, "0")
            ).join("");

            await browser.storage.local.set({ [USER_ID_KEY]: id });

            return id;
        })();

        // If it failed, allow another try next time.
        userIdPromise.catch(() => {
            userIdPromise = null;
        });
    }

    return userIdPromise;
}


// ---------- admin key ----------
// Typed into the popup's Admin section and stored on this device. It is
// read here, in the background script, so it never has to pass through
// the scripts that run inside YouTube pages.

const ADMIN_KEY_STORAGE = "creatorblock_admin_key";   // same as KEY_ADMIN_KEY in shared.js

async function getAdminKey() {
    try {
        const data = await browser.storage.local.get(ADMIN_KEY_STORAGE);

        return data[ADMIN_KEY_STORAGE] || undefined;
    } catch (error) {
        return undefined;
    }
}


// ---------- talking to the server ----------

async function request(method, path, body) {
    const options = { method };

    if (body) {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(body);
    }

    const response = await fetch(API_BASE + path, options);
    const data = await response.json().catch(() => null);

    if (!response.ok) {
        const error = new Error(
            (data && data.message) || "Server error (" + response.status + ")"
        );

        error.status = response.status;
        error.code = data && data.error;

        throw error;
    }

    return data;
}

async function handleMessage(message) {
    switch (message && message.type) {
        case "fetchTags":
            if (!Array.isArray(message.prefixes)) {
                throw new Error("prefixes must be a list");
            }

            return request(
                "GET",
                "/api/tags?prefixes=" + encodeURIComponent(message.prefixes.join(","))
            );

        // Hashing used to happen in the content script itself. On
        // Firefox, crypto.subtle can involve a hop to a different
        // internal process, and something about that combined with a
        // content script's page-bound realm was producing a stub error
        // object (a message but no real stack/prototype) when it
        // resolved. The background script has no such ambiguity - it's
        // a privileged extension page, not injected into any website.
        case "hashPrefix": {
            const bytes = new TextEncoder().encode(message.videoId);
            const digest = await crypto.subtle.digest("SHA-256", bytes);

            const prefix = Array.from(new Uint8Array(digest).slice(0, 2))
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");

            return { prefix };
        }

        case "submitTag":
            return request("POST", "/api/tags", {
                userId: await getUserId(),
                videoId: message.videoId,
                creator: message.creator,
                adminKey: await getAdminKey()
            });

        case "vote":
            return request("POST", "/api/votes", {
                userId: await getUserId(),
                videoId: message.videoId,
                channelId: message.channelId,
                value: message.value,
                adminKey: await getAdminKey()
            });

        // Proving you own a channel (see the popup's "I'm a creator").
        case "ownerChallenge":
            return request("POST", "/api/owner/challenge", {
                userId: await getUserId(),
                channelId: message.channelId
            });

        case "ownerVerify":
            return request("POST", "/api/owner/verify", {
                userId: await getUserId(),
                channelId: message.channelId
            });

        case "ownerMine":
            return request("POST", "/api/owner/mine", {
                userId: await getUserId()
            });

        default:
            throw new Error("Unknown message type");
    }
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only answer this extension's own scripts.
    if (sender.id !== browser.runtime.id) {
        return;
    }

    handleMessage(message).then(
        (data) => sendResponse({ ok: true, data }),
        (error) => {
            // This used to be relayed silently - the content script would
            // re-throw a new Error using just this .message text, with no
            // trace of where it actually came from. Logging it here, in
            // the background script's OWN console, shows us the real
            // source directly instead of guessing from a relayed string.
            console.error("CreatorBlock (background): request failed", error);

            sendResponse({
                ok: false,
                error: error.message,
                status: error.status,
                code: error.code
            });
        }
    );

    // Keep the message channel open for the answer above.
    return true;
});
