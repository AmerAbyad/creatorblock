// ============================================================
// CreatorBlock community sync
//
// Loaded after shared.js and BEFORE content.js (see manifest.json).
// All three run in the same page, so content.js can call the
// functions below and these can call content.js.
//
// - Asks the server who appears in the videos on screen
// - Shares the tags you add, and your "that's wrong" votes
// - All network calls go through background.js
//
// Privacy: the server is never told which videos you look at.
// For each video we send only the first 4 hex characters of a hash
// of its ID; the server answers for every video in that bucket and
// we pick out our own.
// ============================================================

const COMMUNITY_TTL_MS = 5 * 60 * 1000;    // how long fetched tags stay fresh
const COMMUNITY_RETRY_MS = 30 * 1000;      // wait before retrying after an error
const MAX_PREFIXES_PER_REQUEST = 50;

const VIDEO_ID_PATTERN = /^[\w-]{11}$/;

// Profile pictures may only come from YouTube's own image hosts.
const AVATAR_URL_PATTERN =
    /^https:\/\/(yt3\.googleusercontent\.com|yt3\.ggpht\.com|lh3\.googleusercontent\.com)\//;

// videoId -> [{ channelId, name, avatar, handle, score }]
const communityTags = new Map();

const communityFetchedAt = new Map();   // prefix -> when we last asked
const communityInFlight = new Set();    // prefixes being fetched right now
const prefixCache = new Map();          // videoId -> 4-character prefix

// Community tags this person said are wrong (hidden for them from now on).
// { videoId: [channelId, ...] }
let rejected = {};

const REJECTED_KEY = "creatorblock_rejected";


// ============================================================
// TALKING TO THE BACKGROUND SCRIPT
// ============================================================

async function callApi(message) {
    const response = await browser.runtime.sendMessage(message);

    if (!response || !response.ok) {
        console.warn("CreatorBlock: background script responded with", response);

        const error = new Error(
            (response && response.error) || "No answer from the background script"
        );

        error.status = response && response.status;

        throw error;
    }

    return response.data;
}


// ============================================================
// HASH PREFIXES
// ============================================================

async function prefixOf(videoId) {
    const known = prefixCache.get(videoId);

    if (known) {
        return known;
    }

    const { prefix } = await callApi({ type: "hashPrefix", videoId });

    prefixCache.set(videoId, prefix);

    return prefix;
}


// ============================================================
// TAGS YOU DISPUTED
// ============================================================

browser.storage.local.get(REJECTED_KEY).then((data) => {
    rejected = data[REJECTED_KEY] || {};
    scheduleScan();
}).catch(() => {});

browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[REJECTED_KEY]) {
        rejected = changes[REJECTED_KEY].newValue || {};
        scheduleScan();
    }
});

function saveRejected() {
    browser.storage.local.set({ [REJECTED_KEY]: rejected }).catch(() => {});
}

function isRejected(videoId, channelId) {
    return (rejected[videoId] || []).includes(channelId);
}

function rejectTag(videoId, channelId) {
    if (isRejected(videoId, channelId)) {
        return;
    }

    rejected[videoId] = [...(rejected[videoId] || []), channelId];
    saveRejected();
}

function unrejectTag(videoId, channelId) {
    if (!isRejected(videoId, channelId)) {
        return;
    }

    const rest = rejected[videoId].filter((id) => id !== channelId);

    if (rest.length > 0) {
        rejected[videoId] = rest;
    } else {
        delete rejected[videoId];
    }

    saveRejected();
}


// ============================================================
// READING TAGS FROM THE SERVER
// ============================================================

// Never trust what comes back: check every field.
function cleanCommunityTag(tag) {
    if (
        !tag ||
        !/^UC[\w-]{22}$/.test(tag.channelId || "") ||
        typeof tag.name !== "string" ||
        !tag.name.trim()
    ) {
        return null;
    }

    return {
        channelId: tag.channelId,
        name: tag.name.slice(0, 60),
        avatar: AVATAR_URL_PATTERN.test(tag.avatar || "") ? tag.avatar : "",
        handle: typeof tag.handle === "string" ? tag.handle.slice(0, 61) : "",
        score: Number.isFinite(tag.score) ? tag.score : 0,
        ownerConfirmed: tag.ownerConfirmed === true,
        adminLocked: tag.adminLocked === true
    };
}

async function fetchMissingCommunityTags() {
    // If a navigation happens while this function is mid-await, we
    // abandon the rest of the work rather than resume into a page
    // that has since moved on - see navigationGeneration in content.js.
    const myGeneration = navigationGeneration;

    // Every video we can see right now (thumbnails + the one playing).
    const videoIds = new Set();

    try {
        document.querySelectorAll('a[href*="/watch?"]').forEach((link) => {
            const id = getVideoIdFromLink(link);

            if (id) {
                videoIds.add(id);
            }
        });
    } catch (error) {
        logErr("CreatorBlock: could not collect video IDs from the page", error);
    }

    let currentId = null;

    try {
        currentId = getCurrentVideoId();
    } catch (error) {
        logErr("CreatorBlock: could not read the current video ID", error);
    }

    if (currentId) {
        videoIds.add(currentId);
    }

    // Group them by hash prefix, skipping prefixes we already have.
    const wanted = new Map();   // prefix -> [videoId, ...]

    try {
        for (const videoId of videoIds) {
            if (!VIDEO_ID_PATTERN.test(videoId)) {
                continue;
            }

            const prefix = prefixCache.get(videoId) || await prefixOf(videoId);

            if (myGeneration !== navigationGeneration) {
                return;   // the page has navigated since we started - stop here
            }

            const age = Date.now() - (communityFetchedAt.get(prefix) || 0);

            if (age < COMMUNITY_TTL_MS || communityInFlight.has(prefix)) {
                continue;
            }

            if (!wanted.has(prefix)) {
                wanted.set(prefix, []);
            }

            wanted.get(prefix).push(videoId);
        }
    } catch (error) {
        logErr("CreatorBlock: could not compute hash prefixes", error);
    }

    const prefixes = [...wanted.keys()];
    let changed = false;

    for (let i = 0; i < prefixes.length; i += MAX_PREFIXES_PER_REQUEST) {
        const batch = prefixes.slice(i, i + MAX_PREFIXES_PER_REQUEST);

        batch.forEach((prefix) => communityInFlight.add(prefix));

        try {
            const data = await callApi({ type: "fetchTags", prefixes: batch });

            if (myGeneration !== navigationGeneration) {
                return;   // the page has navigated since we started - stop here
            }

            // Videos we asked about that aren't in the answer have no tags.
            batch.forEach((prefix) => {
                wanted.get(prefix).forEach((id) => communityTags.set(id, []));
            });

            for (const [videoId, tags] of Object.entries(data.videos || {})) {
                if (!VIDEO_ID_PATTERN.test(videoId) || !Array.isArray(tags)) {
                    continue;
                }

                communityTags.set(
                    videoId,
                    tags.map(cleanCommunityTag).filter(Boolean)
                );
            }

            batch.forEach((prefix) => communityFetchedAt.set(prefix, Date.now()));
            changed = true;
        } catch (error) {
            logErr("CreatorBlock: could not load community tags", error);

            // Try again in 30 seconds, not on every page change.
            batch.forEach((prefix) => {
                communityFetchedAt.set(
                    prefix,
                    Date.now() - COMMUNITY_TTL_MS + COMMUNITY_RETRY_MS
                );
            });
        } finally {
            batch.forEach((prefix) => communityInFlight.delete(prefix));
        }
    }

    if (changed) {
        try {
            scanThumbnails();
        } catch (error) {
            logErr("CreatorBlock: could not redraw thumbnails after a sync", error);
        }
    }
}

let prefetchRunning = false;
let prefetchAgain = false;

// Safe to call as often as you like: it does nothing when every
// visible video is already up to date, and never runs twice at once.
async function prefetchCommunityTags() {
    if (prefetchRunning) {
        prefetchAgain = true;
        return;
    }

    prefetchRunning = true;

    try {
        await fetchMissingCommunityTags();
    } catch (error) {
        logErr("CreatorBlock: community sync failed", error);
    } finally {
        prefetchRunning = false;
    }

    if (prefetchAgain) {
        prefetchAgain = false;
        prefetchCommunityTags();
    }
}


// ============================================================
// SHARING YOUR TAGS AND VOTES
// ============================================================

async function submitTagToServer(videoId, creator) {
    if (!VIDEO_ID_PATTERN.test(videoId)) {
        return;
    }

    try {
        await callApi({
            type: "submitTag",
            videoId,
            creator: {
                channelId: creator.id,
                name: creator.name,
                avatar: creator.avatar || "",
                handle: creator.handle || ""
            }
        });

        // Ask again soon so the community's view includes your tag.
        communityFetchedAt.delete(await prefixOf(videoId));
        prefetchCommunityTags();
    } catch (error) {
        // Your own tag still works locally. It just wasn't shared this time.
        logErr("CreatorBlock: could not share your tag", error);
    }
}

async function sendVote(videoId, channelId, value) {
    if (!VIDEO_ID_PATTERN.test(videoId)) {
        return;
    }

    try {
        await callApi({ type: "vote", videoId, channelId, value });
    } catch (error) {
        // 404 only means the server never heard of this tag. Nothing to undo.
        if (error.status !== 404) {
            logErr("CreatorBlock: could not send your vote", error);
        }
    }
}

// The ✕ button on a creator in the panel: "they're not in this video".
function dismissCreator(videoId, creator) {
    const wasMine = getVideoCreatorIds(videoId).includes(creator.id);

    removeCreatorFromVideo(videoId, creator.id);   // your own tag, if any
    rejectTag(videoId, creator.id);                // hide it for you

    // Taking back your own tag withdraws your vote (0).
    // Disputing someone else's tag is a downvote (-1).
    sendVote(videoId, creator.id, wasMine ? 0 : -1);
}


// ============================================================
// TAGGING A VIDEO
// ============================================================

// Tag this video with a creator (used by the ✓ button).
// This does NOT add them to your filters. Filters are only added by
// you, in the toolbar popup.
function tagVideoWithCreator(videoId, creator) {
    rememberCreator({
        id: creator.id,
        name: creator.name,
        avatar: creator.avatar || "",
        handle: creator.handle || ""
    });

    addCreatorToVideo(videoId, creator.id);
    unrejectTag(videoId, creator.id);
    submitTagToServer(videoId, creator);
    showCreatorList();
    scanThumbnails();
}


// ============================================================
// CONFIRM BUTTON (✓)
// "Yes, they're in this video" for a tag someone else made.
// ============================================================

function createConfirmButton(videoId, creator) {
    const button = el("button", "creatorblock-confirm", "✓");

    button.type = "button";
    button.title = "Yes, they're in this video";

    button.addEventListener("click", () => {
        tagVideoWithCreator(videoId, creator);
    });

    return button;
}
