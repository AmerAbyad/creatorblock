// ============================================================
// CreatorBlock shared code
//
// Used by BOTH the YouTube page scripts and the toolbar popup:
//   - the storage key names
//   - the four filters (Like, Warn, Dim, Hide) and what each one does
//   - finding a YouTube channel by name, @handle or link
//   - a few small helpers for building page elements
// ============================================================


// ============================================================

// Cross-browser compatibility: everything in this extension is
// written against `browser.*` (Promise-based, no callbacks - Firefox's
// native API). Chrome doesn't have a `browser` global, but its own
// `chrome.*` already returns Promises the same way when no callback
// is given, so pointing `browser` at `chrome` there is enough - no
// other changes needed for Chrome/Brave/Vivaldi/Edge/Opera.
if (typeof browser === "undefined") {
    var browser = chrome;
}


// ============================================================
// STORAGE KEYS (browser.storage.local)
// ============================================================

// Creators we know about (name, picture): just a memory, NOT your filter list.
const KEY_CREATORS = "creatorblock_creators";

// Which creators you tagged in which video.
const KEY_VIDEOS = "creatorblock_video_creators";

// YOUR filter list: { channelId: "like" | "warn" | "dim" | "hide" }.
// A creator is only in here if you added them yourself.
const KEY_FILTERS = "creatorblock_filters";

// The on/off switch (false = paused).
const KEY_ENABLED = "creatorblock_enabled";

// Channels you have proven you own: [{ channelId, name }].
const KEY_OWNED = "creatorblock_owned";

// Your admin key (see the popup's "Admin" section). Stored locally on
// this device only; never sent anywhere except with your own requests.
const KEY_ADMIN_KEY = "creatorblock_admin_key";


// ============================================================
// THE FILTERS
// ============================================================

const MODE_LIST = ["like", "warn", "dim", "hide"];

const MODE_INFO = {
    like: {
        label: "Like",
        icon: "♥",
        option: "♥ Like – highlight in green",
        description: "Highlights videos with this creator using a green badge and a green outline. Nothing is hidden."
    },
    warn: {
        label: "Warn",
        icon: "⚠",
        option: "⚠ Warn – highlight in red",
        description: "Marks videos with this creator using a red badge and a red outline. Nothing is hidden."
    },
    dim: {
        label: "Dim",
        icon: "◐",
        option: "◐ Dim – fade until hover",
        description: "Fades and blurs the video's thumbnail until you move your mouse over it."
    },
    hide: {
        label: "Hide",
        icon: "⊘",
        option: "⊘ Hide – remove video",
        description: "Removes videos with this creator from the page completely."
    }
};

// Higher number = stricter. If a video has several creators, the
// strictest filter decides what happens to the video.
const MODE_RANK = { show: 0, like: 1, warn: 2, dim: 3, hide: 4 };

// The CSS class put on a video card for each filter.
const MODE_CLASS = {
    like: "creatorblock-like",
    warn: "creatorblock-warn",
    dim:  "creatorblock-dim",
    hide: "creatorblock-hidden"
};

const MODE_RULES =
    "If a video has several creators, the strictest filter wins: " +
    "Hide, then Dim, then Warn, then Like. " +
    "Filters only change the video thumbnails in lists (home, search, " +
    "recommendations). A video you open directly still plays.";


// ============================================================
// CHANNEL LOOKUP
// Turns a pasted channel link / @handle / channel ID into a real
// creator (channel ID + name + profile picture) by reading the
// channel's own YouTube page. No API key needed.
// ============================================================

// An error whose message is safe to show to the user.
class LookupError extends Error {}

// Returns the channel page URL to fetch, or null if the text
// doesn't look like a channel reference.
function toChannelUrl(input) {
    const text = (input || "").trim();

    if (!text) {
        return null;
    }

    // Bare channel ID: UCxxxxxxxxxxxxxxxxxxxxxx
    if (/^UC[\w-]{22}$/.test(text)) {
        return "https://www.youtube.com/channel/" + text;
    }

    // Bare handle: @name
    if (/^@[^\s\/]+$/.test(text)) {
        return "https://www.youtube.com/" + text;
    }

    let url;

    try {
        url = new URL(text.includes("://") ? text : "https://" + text);
    } catch (error) {
        return null;
    }

    if (!/(^|\.)youtube\.com$/.test(url.hostname)) {
        return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] && parts[0].startsWith("@")) {
        return "https://www.youtube.com/" + parts[0];
    }

    if (["channel", "c", "user"].includes(parts[0]) && parts[1]) {
        return "https://www.youtube.com/" + parts[0] + "/" + parts[1];
    }

    return null;
}

function decodeEntities(text) {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
            String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) =>
            String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

// Reads every <tagName ...> in the html into a { attribute: value } object.
function parseTags(html, tagName) {
    const tagPattern = new RegExp("<" + tagName + "\\b[^>]*>", "gi");
    const attrPattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

    const tags = [];

    for (const tagMatch of html.matchAll(tagPattern)) {
        const attributes = {};

        for (const attr of tagMatch[0].matchAll(attrPattern)) {
            const value =
                attr[2] !== undefined ? attr[2] :
                attr[3] !== undefined ? attr[3] : attr[4];
            attributes[attr[1].toLowerCase()] = decodeEntities(value);
        }

        tags.push(attributes);
    }

    return tags;
}

function matchChannelId(text, pattern) {
    const match = text ? text.match(pattern) : null;

    return match ? match[1] : "";
}

function firstMatch(text, pattern) {
    const match = text.match(pattern);

    return match ? match[1] : "";
}

// Finds  "key":"UCxxxxxxxxxxxxxxxxxxxxxx"  inside the page's embedded JSON.
// Also matches the \x22-escaped form YouTube sometimes uses.
function findJsonChannelId(html, key) {
    const pattern = new RegExp(
        '(?:"|\\\\x22)' + key + '(?:"|\\\\x22):(?:"|\\\\x22)(UC[\\w-]{22})'
    );

    return firstMatch(html, pattern);
}

// Turns the inside of a JSON string (Tom \u0026 Jerry) into real text.
function unescapeJsonString(raw) {
    try {
        return JSON.parse('"' + raw + '"');
    } catch (error) {
        return raw;
    }
}

async function fetchChannelInfo(input) {
    const channelUrl = toChannelUrl(input);

    if (!channelUrl) {
        throw new LookupError(
            "That doesn't look like a channel. Paste a link like " +
            "youtube.com/@name or youtube.com/channel/..., or an @handle."
        );
    }

    const response = await fetch(channelUrl, { credentials: "same-origin" });

    if (!response.ok) {
        throw new LookupError("YouTube couldn't find that channel.");
    }

    const html = await response.text();

    // <head> holds the page's meta tags and links.
    const headEnd = html.indexOf("</head>");
    const head = headEnd > 0 ? html.slice(0, headEnd) : html.slice(0, 300000);

    const metas = parseTags(head, "meta");
    const links = parseTags(head, "link");

    function meta(key) {
        const tag = metas.find((t) =>
            t.property === key || t.name === key || t.itemprop === key
        );

        return tag && tag.content ? tag.content : "";
    }

    const canonical = links.find((t) => t.rel === "canonical");

    // The channel ID can live in several independent places on the page.
    // Try them one after another until one has it.
    const channelId =
        matchChannelId(canonical && canonical.href, /\/channel\/(UC[\w-]{22})/) ||
        firstMatch(html, /videos\.xml\?channel_id=(UC[\w-]{22})/) ||
        findJsonChannelId(html, "externalId") ||
        matchChannelId(meta("channelId"), /^(UC[\w-]{22})$/) ||
        matchChannelId(meta("identifier"), /^(UC[\w-]{22})$/) ||
        findJsonChannelId(html, "channelId") ||
        findJsonChannelId(html, "browseId");

    const titleTag = firstMatch(head, /<title[^>]*>([^<]*)<\/title>/i);

    const name = (
        meta("og:title") ||
        meta("title") ||
        unescapeJsonString(
            firstMatch(html, /"channelMetadataRenderer":\{"title":"((?:[^"\\]|\\.)*)"/)
        ) ||
        decodeEntities(titleTag).replace(/\s*-\s*YouTube\s*$/i, "")
    ).trim();

    if (!channelId || !name) {
        // Leave a trail in the console so a failure can be diagnosed.
        console.warn("CreatorBlock: unreadable channel page", {
            requested: channelUrl,
            finalUrl: response.url,
            status: response.status,
            length: html.length,
            hasHead: headEnd > 0,
            foundChannelId: channelId || null,
            foundName: name || null,
            start: html.slice(0, 600)
        });

        throw new LookupError(
            !channelId
                ? "Couldn't find that channel's ID on the page YouTube returned."
                : "Couldn't find that channel's name on the page YouTube returned."
        );
    }

    return {
        id: channelId,
        name: name.slice(0, 60),
        avatar: normalizeAvatarUrl(meta("og:image")),
        handle: safeDecode(firstMatch(channelUrl, /\/(@[^\/?#]+)$/))
    };
}


// ============================================================
// CHANNEL SEARCH
// Uses YouTube's own search with the "Channels" filter, so people
// can be found by display name OR @handle, in any capitalisation.
// ============================================================

const searchCache = new Map();   // "query" -> [creator, ...]

function safeDecode(text) {
    try {
        return decodeURIComponent(text);
    } catch (error) {
        return text;
    }
}

// Cleans up a profile picture URL: https only, and a small size.
function normalizeAvatarUrl(url) {
    let avatar = url || "";

    if (avatar.startsWith("//")) {
        avatar = "https:" + avatar;
    }

    if (!avatar.startsWith("https://")) {
        return "";
    }

    if (/googleusercontent\.com|ggpht\.com/.test(avatar)) {
        avatar = avatar.replace(/=s\d+(?=-|$)/, "=s96");
    }

    return avatar;
}

// Pulls the big  var ytInitialData = {...};  object out of a YouTube
// page and parses it. Returns null if it can't be found.
function extractInitialData(html) {
    for (const match of html.matchAll(/ytInitialData["\]]*\s*=\s*/g)) {
        const start = match.index + match[0].length;

        if (html[start] !== "{") {
            continue;
        }

        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = start; i < html.length; i++) {
            const ch = html[i];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch === "\\") {
                    escaped = true;
                } else if (ch === '"') {
                    inString = false;
                }
            } else if (ch === '"') {
                inString = true;
            } else if (ch === "{") {
                depth++;
            } else if (ch === "}") {
                depth--;

                if (depth === 0) {
                    try {
                        return JSON.parse(html.slice(start, i + 1));
                    } catch (error) {
                        return null;
                    }
                }
            }
        }
    }

    return null;
}

// Collects the value of every property called `key`, at any depth.
function collectByKey(node, key, found) {
    if (!node || typeof node !== "object") {
        return;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            collectByKey(item, key, found);
        }

        return;
    }

    for (const name of Object.keys(node)) {
        if (name === key) {
            found.push(node[name]);
        } else {
            collectByKey(node[name], key, found);
        }
    }
}

// YouTube text fields are either { simpleText } or { runs: [{ text }] }.
function textOf(value) {
    if (!value) {
        return "";
    }

    if (typeof value === "string") {
        return value;
    }

    if (value.simpleText) {
        return value.simpleText;
    }

    if (Array.isArray(value.runs)) {
        return value.runs.map((run) => run.text || "").join("");
    }

    return "";
}

function creatorFromChannelRenderer(renderer) {
    const endpoint = renderer.navigationEndpoint || {};
    const browse = endpoint.browseEndpoint || {};

    const id = renderer.channelId || browse.browseId || "";

    if (!/^UC[\w-]{22}$/.test(id)) {
        return null;
    }

    const name = textOf(renderer.title).trim();

    if (!name) {
        return null;
    }

    const thumbnails =
        (renderer.thumbnail && renderer.thumbnail.thumbnails) || [];

    const avatar = normalizeAvatarUrl(
        thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : ""
    );

    // The @handle: from the channel's URL if possible. (YouTube also
    // puts it in the subscriber-count text, with the counts swapped.)
    const webUrl =
        (endpoint.commandMetadata &&
         endpoint.commandMetadata.webCommandMetadata &&
         endpoint.commandMetadata.webCommandMetadata.url) || "";

    const path = [browse.canonicalBaseUrl, webUrl]
        .find((p) => p && p.startsWith("/@"));

    const texts = [
        textOf(renderer.subscriberCountText),
        textOf(renderer.videoCountText)
    ];

    const handle = path
        ? safeDecode(path.slice(1))
        : (texts.find((t) => t.startsWith("@")) || "");

    const subscribers = texts.find((t) => /subscriber/i.test(t)) || "";

    return { id, name: name.slice(0, 60), avatar, handle, subscribers };
}

// Returns a list of creators, or null if the page had no search data.
function parseChannelSearchResults(html) {
    const data = extractInitialData(html);

    if (!data) {
        return null;
    }

    const renderers = [];
    collectByKey(data, "channelRenderer", renderers);

    const seen = new Set();
    const found = [];

    for (const renderer of renderers) {
        const creator = creatorFromChannelRenderer(renderer);

        if (creator && !seen.has(creator.id)) {
            seen.add(creator.id);
            found.push(creator);
        }

        if (found.length >= 8) {
            break;
        }
    }

    return found;
}

async function searchChannels(query) {
    const text = query.trim().slice(0, 80);
    const key = text.toLowerCase();

    if (searchCache.has(key)) {
        return searchCache.get(key);
    }

    // sp=EgIQAg%3D%3D is YouTube's "Type: Channel" search filter.
    const url =
        "https://www.youtube.com/results?search_query=" +
        encodeURIComponent(text) +
        "&sp=EgIQAg%3D%3D";

    const response = await fetch(url, { credentials: "same-origin" });

    if (!response.ok) {
        throw new LookupError("YouTube search isn't available right now.");
    }

    const html = await response.text();
    const found = parseChannelSearchResults(html);

    if (found === null) {
        console.warn("CreatorBlock: no search data in YouTube's response", {
            status: response.status,
            length: html.length,
            start: html.slice(0, 600)
        });

        throw new LookupError("Couldn't read YouTube's search results.");
    }

    searchCache.set(key, found);

    if (searchCache.size > 50) {
        searchCache.delete(searchCache.keys().next().value);
    }

    return found;
}


// ============================================================
// SMALL DOM HELPERS
// (textContent instead of innerHTML, so creator names coming
// from a shared database can never inject HTML)
// ============================================================

// The console couldn't even expand some of the errors we were
// catching (no triangle, no way to inspect them) - a sign Firefox's
// own console was hitting the same restriction trying to format the
// object itself. Logging plain strings instead sidesteps that
// entirely, whatever the underlying cause turns out to be.
function logErr(prefix, error) {
    try {
        console.warn(
            prefix,
            "| name:", error && error.name,
            "| message:", error && error.message,
            "| stack:", error && error.stack
        );
    } catch (loggingError) {
        console.warn(prefix, "| (error itself could not be read):", String(loggingError));
    }
}

function el(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
        node.className = className;
    }

    if (text !== undefined) {
        node.textContent = text;
    }

    return node;
}

// Use these (instead of parent.appendChild(...) / parent.insertBefore(...))
// whenever "parent" is a page-owned element - a YouTube custom element
// like yt-thumbnail-view-model/ytd-thumbnail, or its player chrome -
// rather than something we created ourselves with el() above. Firefox
// isolates content scripts from the page via "Xray vision": calling a
// method directly on a page-defined custom element can route through
// that page's own (possibly overridden) version of the method instead
// of the plain native one, which throws "Permission denied to access
// property 'constructor'" for some of YouTube's own elements. Calling
// the native method via Node.prototype sidesteps that. Chrome has no
// such isolation, so this is a no-op difference there - safe either way.
function appendNative(parent, child) {
    Node.prototype.appendChild.call(parent, child);
}

function insertBeforeNative(parent, child, reference) {
    Node.prototype.insertBefore.call(parent, child, reference);
}

function createAvatar(creator, className) {
    const image = el("img", className);

    image.alt = creator.name;

    // If the picture fails to load, fall back to a plain grey circle.
    image.addEventListener("error", () => {
        image.alt = "";
        image.removeAttribute("src");
    });

    if (creator.avatar) {
        image.src = creator.avatar;
    }

    return image;
}


// ============================================================
// FILTER WIDGETS
// ============================================================

// A drop-down of the four filters. `onChange` gets the chosen filter
// ("like" / "warn" / "dim" / "hide"), or "" for the placeholder.
function createModeSelect(current, onChange, placeholder) {
    const select = el("select", "creatorblock-mode");

    if (placeholder) {
        const first = el("option", "", placeholder);

        first.value = "";
        select.appendChild(first);
    }

    MODE_LIST.forEach((mode) => {
        const option = el("option", "", MODE_INFO[mode].option);

        option.value = mode;
        select.appendChild(option);
    });

    select.value = current || "";

    select.addEventListener("change", () => onChange(select.value));

    return select;
}

// "What each filter does", spelled out.
function createModeLegend() {
    const box = el("div", "creatorblock-legend");

    MODE_LIST.forEach((mode) => {
        const info = MODE_INFO[mode];
        const row = el("div", "creatorblock-legend-row");
        const text = el("div", "creatorblock-legend-text");

        row.appendChild(
            el("span", "creatorblock-legend-icon creatorblock-legend-" + mode, info.icon)
        );

        text.appendChild(el("strong", "", info.label));
        text.appendChild(el("span", "", " – " + info.description));

        row.appendChild(text);
        box.appendChild(row);
    });

    box.appendChild(el("div", "creatorblock-legend-note", MODE_RULES));

    return box;
}
