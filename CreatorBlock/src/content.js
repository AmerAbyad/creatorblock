console.log("CreatorBlock is running!");

// Loaded after shared.js and community.js (see manifest.json). This file
// is the page logic: your data, the panel on the video, and the badges
// and filters on the thumbnails.


// ============================================================
// SETTINGS
// ============================================================

const CARD_CLASSES = Object.values(MODE_CLASS);

// Max creator badges drawn on one thumbnail (the rest become "+N").
const MAX_BADGES = 3;

// Outermost-first: we want to hide the whole grid cell, not just
// an inner piece of it (which would leave an empty gap).
const CARD_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-playlist-video-renderer",
    "yt-lockup-view-model"
];


// ============================================================
// YOUR DATA (browser.storage.local, shared across tabs)
// ============================================================

// Creators we know about (name, picture). Filled in whenever you tag a
// creator in a video, or add one in the popup. It is only a memory of
// who is who. It is NOT your filter list.
let creators = {};

// Which creators you tagged in which video.
// { videoId: [channelId, ...] }
let videoCreators = {};

// YOUR filter list: only creators you added yourself, in the toolbar popup.
// { channelId: "like" | "warn" | "dim" | "hide" }
let filters = {};

// The on/off switch in the popup.
let enabled = true;

async function loadData() {
    try {
        const data = await browser.storage.local.get(
            [KEY_CREATORS, KEY_VIDEOS, KEY_FILTERS, KEY_ENABLED]
        );

        creators = data[KEY_CREATORS] || {};
        videoCreators = data[KEY_VIDEOS] || {};
        filters = data[KEY_FILTERS] || {};
        enabled = data[KEY_ENABLED] !== false;
    } catch (error) {
        console.error("CreatorBlock: could not load data", error);
    }
}

// Saves one piece of data. Only that piece is written, so this never
// overwrites something the popup just changed.
function saveKey(key, value) {
    try {
        browser.storage.local.set({ [key]: value }).catch((error) => {
            console.error("CreatorBlock: could not save data", error);
        });
    } catch (error) {
        console.error("CreatorBlock: could not save data", error);
    }
}

// Keep other open YouTube tabs (and the popup's changes) in sync.
browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
        return;
    }

    if (changes[KEY_CREATORS]) {
        creators = changes[KEY_CREATORS].newValue || {};
    }

    if (changes[KEY_VIDEOS]) {
        videoCreators = changes[KEY_VIDEOS].newValue || {};
    }

    if (changes[KEY_FILTERS]) {
        filters = changes[KEY_FILTERS].newValue || {};
    }

    if (changes[KEY_ENABLED]) {
        enabled = changes[KEY_ENABLED].newValue !== false;
    }

    scheduleScan();
});


// ============================================================
// DATA HELPERS
// ============================================================

function getCreatorById(id) {
    return creators[id] || null;
}

// Every creator we know about (used to search when tagging a video).
function getAllCreators() {
    return Object.values(creators).sort((a, b) =>
        a.name.localeCompare(b.name)
    );
}

// Remember a creator's name and picture. This does NOT put them in
// your filter list.
function rememberCreator(creator) {
    creators[creator.id] = creator;
    saveKey(KEY_CREATORS, creators);
}

function getVideoCreatorIds(videoId) {
    return videoCreators[videoId] || [];
}

// Everyone tagged in this video: the community's tags plus your own.
function getCreatorsForVideo(videoId) {
    const merged = new Map();

    // What the community says about this video...
    for (const tag of communityTags.get(videoId) || []) {
        if (isRejected(videoId, tag.channelId)) {
            continue;
        }

        merged.set(tag.channelId, {
            id: tag.channelId,
            name: tag.name,
            avatar: tag.avatar,
            handle: tag.handle,
            ownerConfirmed: tag.ownerConfirmed === true,
            adminLocked: tag.adminLocked === true
        });
    }

    // ...plus what you tagged yourself.
    for (const id of getVideoCreatorIds(videoId)) {
        const mine = getCreatorById(id);

        if (mine && !merged.has(id)) {
            merged.set(id, mine);
        }
    }

    return [...merged.values()];
}

function addCreatorToVideo(videoId, creatorId) {
    if (!videoId) {
        return;
    }

    const ids = getVideoCreatorIds(videoId);

    if (ids.includes(creatorId)) {
        return;
    }

    videoCreators[videoId] = [...ids, creatorId];
    saveKey(KEY_VIDEOS, videoCreators);
}

function removeCreatorFromVideo(videoId, creatorId) {
    const ids = getVideoCreatorIds(videoId)
        .filter((id) => id !== creatorId);

    if (ids.length > 0) {
        videoCreators[videoId] = ids;
    } else {
        delete videoCreators[videoId];
    }

    saveKey(KEY_VIDEOS, videoCreators);
}

// The filter you set for a creator: "like" / "warn" / "dim" / "hide",
// or "" if they aren't in your list.
function getFilter(creatorId) {
    return MODE_LIST.includes(filters[creatorId]) ? filters[creatorId] : "";
}

// What actually happens right now (nothing at all while paused).
function getMode(creatorId) {
    return enabled ? (getFilter(creatorId) || "show") : "show";
}

// Your filter list, with names and pictures.
function getFilterList() {
    return Object.keys(filters)
        .filter((id) => MODE_LIST.includes(filters[id]))
        .map((id) => creators[id] || { id, name: id, avatar: "", handle: "" })
        .sort((a, b) => a.name.localeCompare(b.name));
}

function setFilter(creatorId, mode) {
    if (!MODE_LIST.includes(mode)) {
        return;
    }

    filters[creatorId] = mode;
    saveKey(KEY_FILTERS, filters);
    scanThumbnails();
}

function removeFilter(creatorId) {
    delete filters[creatorId];
    saveKey(KEY_FILTERS, filters);
    scanThumbnails();
}

// Of all the creators in a video, the filter that wins.
function strictestMode(list) {
    let strictest = "show";

    list.forEach((creator) => {
        const mode = getMode(creator.id);

        if (MODE_RANK[mode] > MODE_RANK[strictest]) {
            strictest = mode;
        }
    });

    return strictest;
}


// ============================================================
// CURRENT VIDEO
// ============================================================

let lastVideoId = null;

// Bumped on every YouTube in-page navigation - see the yt-navigate-finish
// listener in init(). Async work checks this to detect it's become stale.
let navigationGeneration = 0;

function getCurrentVideoId() {
    const url = new URL(window.location.href);

    if (url.pathname !== "/watch") {
        return null;
    }

    return url.searchParams.get("v");
}

function checkCurrentVideo() {
    const videoId = getCurrentVideoId();

    if (!videoId) {
        lastVideoId = null;
        closePanel();
        return;
    }

    if (videoId === lastVideoId) {
        return;
    }

    lastVideoId = videoId;

    // The panel belongs to the previous video, so close it.
    closePanel();

    console.log("CreatorBlock current video:", videoId);
}


// ============================================================
// PLAYER BUTTON
// ============================================================

function addCreatorButton() {
    if (document.querySelector(".creatorblock-player-button")) {
        return;
    }

    const controls = document.querySelector(".ytp-right-controls");

    if (!controls) {
        return;
    }

    const button = el("button", "creatorblock-player-button");

    const icon = el("img", "creatorblock-player-icon");
    icon.src = browser.runtime.getURL("icons/icon32.png");
    icon.alt = "";
    button.appendChild(icon);

    button.type = "button";
    button.title = "CreatorBlock";

    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleCreatorPanel();
    });

    const reference = controls.children[5];

    if (reference) {
        insertBeforeNative(controls, button, reference);
    } else {
        appendNative(controls, button);
    }
}


// ============================================================
// PANEL
// ============================================================

function getPanel() {
    return document.querySelector(".creatorblock-player-panel");
}

function closePanel() {
    const panel = getPanel();

    if (panel) {
        panel.remove();
    }

    const button = document.querySelector(".creatorblock-player-button");

    if (button) {
        button.classList.remove("creatorblock-active");
    }
}

function toggleCreatorPanel() {
    if (getPanel()) {
        closePanel();
        return;
    }

    const player = document.querySelector(".html5-video-player");

    if (!player) {
        return;
    }

    const button = document.querySelector(".creatorblock-player-button");

    if (button) {
        button.classList.add("creatorblock-active");
    }

    const panel = el("div", "creatorblock-player-panel");

    // Clicks and keys inside the panel must never reach YouTube's
    // player (otherwise typing "k" pauses the video, double-click
    // goes fullscreen, and so on). They also never reach the
    // "click outside to close" handler below.
    [
        "click", "dblclick", "mousedown",
        "keydown", "keypress", "keyup"
    ].forEach((type) => {
        panel.addEventListener(type, (event) => event.stopPropagation());
    });

    appendNative(player, panel);

    showCreatorList();
}

// Empties the panel and draws a fresh header. Returns the panel.
function preparePanel(title, subtitle) {
    const panel = getPanel();

    if (!panel) {
        return null;
    }

    panel.replaceChildren();

    panel.appendChild(el("div", "creatorblock-panel-header", title));

    if (subtitle) {
        panel.appendChild(el("div", "creatorblock-panel-subtitle", subtitle));
    }

    return panel;
}


// ---------- pieces of a row ----------

// A small coloured label: "♥ Like", "⚠ Warn", "✓ creator"...
function createChip(kind, text) {
    return el("span", "creatorblock-chip creatorblock-chip-" + kind, text);
}

// A creator in this video: picture, name, your filter for them (if you
// set one), a ✓ to confirm and a ✕ to say they aren't in the video.
function createVideoCreatorRow(videoId, creator) {
    const row = el("div", "creatorblock-creator");
    const text = el("div", "creatorblock-creator-text");
    const chips = el("div", "creatorblock-chips");

    text.appendChild(el("span", "creatorblock-creator-name", creator.name));

    const mode = getFilter(creator.id);

    if (mode) {
        chips.appendChild(createChip(mode, MODE_INFO[mode].icon + " " + MODE_INFO[mode].label));
    }

    if (creator.ownerConfirmed) {
        chips.appendChild(createChip("creator", "✓ confirmed by the creator"));
    }

    if (chips.children.length > 0) {
        text.appendChild(chips);
    }

    row.appendChild(createAvatar(creator));
    row.appendChild(text);

    // Someone else's tag that you haven't confirmed yet: offer a ✓.
    if (!getVideoCreatorIds(videoId).includes(creator.id)) {
        row.appendChild(createConfirmButton(videoId, creator));
    }

    const removeButton = el("button", "creatorblock-remove", "✕");

    removeButton.type = "button";
    removeButton.title = "They're not in this video";

    removeButton.addEventListener("click", () => {
        dismissCreator(videoId, creator);
        showCreatorList();
        scanThumbnails();
    });

    row.appendChild(removeButton);

    return row;
}

// A creator in your filter list: picture, name, what to do about them,
// and a ✕ that takes them off the list.
function createFilterRow(creator) {
    const row = el("div", "creatorblock-creator");
    const text = el("div", "creatorblock-creator-text");

    text.appendChild(el("span", "creatorblock-creator-name", creator.name));

    text.appendChild(
        createModeSelect(getFilter(creator.id), (mode) => {
            if (mode) {
                setFilter(creator.id, mode);
            }
        })
    );

    const removeButton = el("button", "creatorblock-remove", "✕");

    removeButton.type = "button";
    removeButton.title = "Take off my filter list";

    removeButton.addEventListener("click", () => {
        removeFilter(creator.id);
        showFiltersInterface();
    });

    row.appendChild(createAvatar(creator));
    row.appendChild(text);
    row.appendChild(removeButton);

    return row;
}


// ---------- View 1: creators in this video ----------

function showCreatorList() {
    const panel = preparePanel("CreatorBlock", "Creators in this video");

    if (!panel) {
        return;
    }

    const videoId = getCurrentVideoId();
    const list = videoId ? getCreatorsForVideo(videoId) : [];

    if (list.length === 0) {
        panel.appendChild(
            el("div", "creatorblock-search-hint", "No creators added yet.")
        );
    }

    list.forEach((creator) => {
        panel.appendChild(createVideoCreatorRow(videoId, creator));
    });

    const addButton = el("button", "creatorblock-add", "+ Add Creator");
    addButton.type = "button";
    addButton.addEventListener("click", showAddCreatorInterface);

    const filtersButton = el("button", "creatorblock-cancel", "My Filters");
    filtersButton.type = "button";
    filtersButton.addEventListener("click", showFiltersInterface);

    panel.appendChild(addButton);
    panel.appendChild(filtersButton);
}


// ---------- View 2: add a creator to this video ----------

function showAddCreatorInterface() {
    const panel = preparePanel(
        "Add Creator",
        "Search YouTube channels by name or @handle, or paste a channel link."
    );

    if (!panel) {
        return;
    }

    const videoId = getCurrentVideoId();

    let lookupRunning = false;
    let searchTimer = null;
    let searchToken = 0;   // changes on every keystroke so old answers are ignored
    let searchState = { query: "", status: "idle", found: [], message: "" };

    const input = el("input", "creatorblock-search");
    input.type = "text";
    input.placeholder = "Name, @handle, or channel link";
    input.autocomplete = "off";

    const results = el("div", "creatorblock-search-results");

    const cancelButton = el("button", "creatorblock-cancel", "Cancel");
    cancelButton.type = "button";
    cancelButton.addEventListener("click", showCreatorList);

    function showMessage(text, className) {
        results.replaceChildren(
            el("div", className || "creatorblock-search-hint", text)
        );
    }

    // Save the creator (name, picture, handle) and tag this video with them.
    function choose(creator) {
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

    // Exact lookup of a pasted link / @handle / channel ID.
    async function lookUp(query) {
        if (lookupRunning) {
            return;
        }

        lookupRunning = true;
        showMessage("Looking up channel…");

        try {
            choose(await fetchChannelInfo(query));
        } catch (error) {
            console.error("CreatorBlock: channel lookup failed", error);

            showMessage(
                error instanceof LookupError
                    ? error.message
                    : "Couldn't look up that channel. Try again in a moment.",
                "creatorblock-search-error"
            );
        } finally {
            lookupRunning = false;
        }
    }

    function isLinkLike(query) {
        return /^(https?:\/\/|www\.|(m\.)?youtube\.com)/i.test(query) ||
               /^UC[\w-]{22}$/.test(query);
    }

    function createResultRow(creator, metaText) {
        const row = el("div", "creatorblock-search-result");
        const text = el("div", "creatorblock-result-text");

        text.appendChild(el("span", "creatorblock-result-name", creator.name));

        if (metaText) {
            text.appendChild(el("span", "creatorblock-result-meta", metaText));
        }

        row.appendChild(createAvatar(creator));
        row.appendChild(text);
        row.addEventListener("click", () => choose(creator));

        return row;
    }

    function render() {
        const query = input.value.trim();

        if (!query) {
            showMessage("Type a channel name or @handle, or paste a channel link.");
            return;
        }

        const lower = query.toLowerCase();
        const bare = lower.replace(/^@/, "");

        // Case doesn't matter, and the name OR the @handle can match.
        const savedMatches = getAllCreators().filter((creator) =>
            creator.name.toLowerCase().includes(lower) ||
            (creator.handle || "").toLowerCase().replace(/^@/, "").includes(bare)
        );

        results.replaceChildren();

        // A pasted link or a typed @handle can be looked up exactly.
        if (toChannelUrl(query)) {
            const lookup = el(
                "div",
                "creatorblock-search-result creatorblock-lookup"
            );

            lookup.appendChild(
                el("span", "creatorblock-result-name", "+ Add channel “" + query + "”")
            );
            lookup.addEventListener("click", () => lookUp(query));

            results.appendChild(lookup);
        }

        savedMatches.forEach((creator) => {
            results.appendChild(createResultRow(creator, creator.handle));
        });

        if (isLinkLike(query)) {
            return;
        }

        if (query.length < 2) {
            results.appendChild(
                el("div", "creatorblock-search-hint", "Keep typing to search YouTube.")
            );
            return;
        }

        if (searchState.query !== lower || searchState.status === "loading") {
            results.appendChild(
                el("div", "creatorblock-search-hint", "Searching YouTube…")
            );
            return;
        }

        if (searchState.status === "error") {
            results.appendChild(
                el("div", "creatorblock-search-error", searchState.message)
            );
            return;
        }

        const savedIds = new Set(savedMatches.map((creator) => creator.id));
        const fresh = searchState.found.filter((creator) => !savedIds.has(creator.id));

        fresh.forEach((creator) => {
            results.appendChild(
                createResultRow(
                    creator,
                    [creator.handle, creator.subscribers].filter(Boolean).join(" · ")
                )
            );
        });

        if (fresh.length === 0 && savedMatches.length === 0) {
            results.appendChild(
                el("div", "creatorblock-search-hint", "No channels found for “" + query + "”.")
            );
        }
    }

    async function runSearch(query, token) {
        const lower = query.toLowerCase();

        try {
            const found = await searchChannels(query.replace(/^@/, ""));

            if (token !== searchToken || !results.isConnected) {
                return;
            }

            searchState = { query: lower, status: "done", found, message: "" };
        } catch (error) {
            console.error("CreatorBlock: channel search failed", error);

            if (token !== searchToken || !results.isConnected) {
                return;
            }

            searchState = {
                query: lower,
                status: "error",
                found: [],
                message: error instanceof LookupError
                    ? error.message
                    : "Couldn't search YouTube right now. You can still paste a channel link."
            };
        }

        render();
    }

    // Waits for a pause in typing before asking YouTube.
    function scheduleSearch(immediate) {
        clearTimeout(searchTimer);

        const token = ++searchToken;
        const query = input.value.trim();

        if (query.length < 2 || isLinkLike(query)) {
            searchState = { query: "", status: "idle", found: [], message: "" };
            return;
        }

        searchState = {
            query: query.toLowerCase(),
            status: "loading",
            found: [],
            message: ""
        };

        searchTimer = setTimeout(() => runSearch(query, token), immediate ? 0 : 500);
    }

    input.addEventListener("input", () => {
        scheduleSearch(false);
        render();
    });

    input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
            return;
        }

        event.preventDefault();

        const query = input.value.trim();

        if (toChannelUrl(query)) {
            lookUp(query);
        } else {
            scheduleSearch(true);
            render();
        }
    });

    panel.append(input, results, cancelButton);

    render();
    input.focus();
}


// ---------- View 3: your filter list (change or remove; add in the popup) ----------

function showFiltersInterface() {
    const panel = preparePanel("My Filters", "What happens to videos featuring each creator");

    if (!panel) {
        return;
    }

    panel.appendChild(createModeLegend());

    const list = getFilterList();

    if (list.length === 0) {
        panel.appendChild(
            el("div", "creatorblock-search-hint", "Your list is empty.")
        );
    }

    list.forEach((creator) => {
        panel.appendChild(createFilterRow(creator));
    });

    panel.appendChild(
        el(
            "div",
            "creatorblock-search-hint",
            "To add a creator to this list, click the CreatorBlock icon in your browser's toolbar."
        )
    );

    const backButton = el("button", "creatorblock-cancel", "Back");
    backButton.type = "button";
    backButton.addEventListener("click", showCreatorList);

    panel.appendChild(backButton);
}


// ============================================================
// THUMBNAILS
// ============================================================

// True for a Shorts link, or anything inside a Shorts shelf/card.
// CreatorBlock deliberately never shows badges or applies filters on
// Shorts, whatever the href actually looks like.
function isShortsHref(href) {
    return /^\/shorts\//.test(href || "");
}

function isShortsLink(link) {
    if (isShortsHref(link.getAttribute("href"))) {
        return true;
    }

    return !!link.closest(
        "ytd-reel-item-renderer, ytd-reel-shelf-renderer, " +
        "ytm-shorts-lockup-view-model-v2, yt-shorts-lockup-view-model, [is-shorts]"
    );
}

function getVideoIdFromHref(href) {
    try {
        const url = new URL(href, window.location.origin);

        if (url.pathname !== "/watch") {
            return null;
        }

        return url.searchParams.get("v");
    } catch (error) {
        return null;
    }
}

function getVideoIdFromLink(link) {
    return getVideoIdFromHref(link.getAttribute("href"));
}

function findThumbnail(link) {
    const selector = "yt-thumbnail-view-model, ytd-thumbnail";

    return link.closest(selector) || link.querySelector(selector);
}

function findCard(element) {
    for (const selector of CARD_SELECTORS) {
        const card = element.closest(selector);

        if (card) {
            return card;
        }
    }

    return null;
}

// The suggestion grid YouTube's own player shows at the very end of a
// video. It has no yt-thumbnail-view-model / ytd-thumbnail inside it,
// so it needs its own way of finding the video link.
function getEndscreenTiles() {
    return document.querySelectorAll(".ytp-videowall-still, .ytp-modern-videowall-still");
}

function getEndscreenHref(tile) {
    if (tile.tagName === "A") {
        return tile.getAttribute("href");
    }

    const link = tile.querySelector("a[href]") || tile.closest("a[href]");

    return link ? link.getAttribute("href") : null;
}

// ============================================================
// FLOATING BADGE LAYER
//
// Inserting a badge as a child of YouTube's own thumbnail element
// repeatedly collided with its reactive framework (Lit/Polymer) on
// Firefox - cloneInto (tried as a fix) turned out to not actually
// support cloning DOM nodes at all, just a red herring. Instead,
// every badge lives here, in one plain layer we created and fully
// own, positioned on top of its thumbnail using on-screen
// coordinates. We never become a child of anything YouTube owns, so
// there's nothing for its framework to react to.
// ============================================================

let overlayRoot = null;

function getOverlayLayer() {
    if (overlayRoot && document.body.contains(overlayRoot)) {
        return overlayRoot;
    }

    overlayRoot = el("div", "creatorblock-overlay-root");
    document.body.appendChild(overlayRoot);   // document.body is plain, not YouTube's - safe as-is

    return overlayRoot;
}

// thumbnail element -> its floating badge
const thumbnailBadges = new Map();

function positionBadge(thumbnail, badge) {
    const rect = thumbnail.getBoundingClientRect();

    // Fully off-screen (scrolled away, behind the sticky top bar, etc.)
    // - hide rather than leave it floating with nothing to anchor to.
    if (rect.bottom <= 0 || rect.top >= window.innerHeight ||
        rect.right <= 0 || rect.left >= window.innerWidth || rect.top < 0) {
        badge.style.display = "none";
        return;
    }

    badge.style.display = "flex";
    badge.style.top = (rect.top + 8) + "px";
    badge.style.left = (rect.left + 8) + "px";
    badge.style.maxWidth = Math.max(rect.width - 16, 0) + "px";
}

// Repositioning only on scroll/resize *events* always lags a frame or
// two behind actual scrolling (events fire, then we react), which is
// what showed up as jitter. Instead, as long as there's at least one
// badge on screen, we just recompute every animation frame - this
// runs in lockstep with the browser's own compositing, so badges stay
// visually glued to their thumbnail even during fast/inertial scroll.
function trackBadgePositions() {
    thumbnailBadges.forEach((badge, thumbnail) => {
        if (document.contains(thumbnail)) {
            positionBadge(thumbnail, badge);
        }
    });

    requestAnimationFrame(trackBadgePositions);
}

requestAnimationFrame(trackBadgePositions);

function buildThumbnailBadge(list) {
    // Strictest filters first, so they are never the ones cut off.
    const sorted = [...list].sort(
        (a, b) => MODE_RANK[getMode(b.id)] - MODE_RANK[getMode(a.id)]
    );

    const visible = sorted.slice(0, MAX_BADGES);
    const extraCount = sorted.length - visible.length;

    const container = el("div", "creatorblock-thumbnail-creators");

    visible.forEach((creator) => {
        const mode = getMode(creator.id);

        const badge = el(
            "div",
            mode === "show"
                ? "creatorblock-badge"
                : "creatorblock-badge creatorblock-badge-" + mode
        );

        badge.appendChild(createAvatar(creator, "creatorblock-avatar"));
        badge.appendChild(
            el("span", "", (mode === "show" ? "" : MODE_INFO[mode].icon + " ") + creator.name)
        );

        container.appendChild(badge);
    });

    if (extraCount > 0) {
        container.appendChild(
            el("div", "creatorblock-badge", "+" + extraCount)
        );
    }

    return container;
}

// Draws (or redraws, or clears) one thumbnail's badge and filter class,
// and marks it as accounted for. Shared by the normal scan below and the
// end-of-video suggestion grid, so both behave identically.
function applyToThumbnail(thumbnail, videoId, activeThumbnails) {
    activeThumbnails.add(thumbnail);

    // While paused, no video gets a badge or a filter.
    const list = enabled ? getCreatorsForVideo(videoId) : [];

    // A fingerprint of what this thumbnail should currently show.
    // If it hasn't changed we do nothing. If YouTube reused the
    // element for another video, or a filter changed, it differs
    // and we redraw from scratch.
    const signature =
        videoId + "|" +
        list.map((c) => c.id + ":" + getMode(c.id)).join(",");

    if (thumbnail.dataset.creatorblockSig === signature) {
        const existing = thumbnailBadges.get(thumbnail);

        if (existing) {
            positionBadge(thumbnail, existing);
        }

        return;
    }

    thumbnail.dataset.creatorblockSig = signature;

    // Wipe whatever was drawn before.
    const old = thumbnailBadges.get(thumbnail);

    if (old) {
        old.remove();
        thumbnailBadges.delete(thumbnail);
    }

    const card = findCard(thumbnail) || thumbnail;
    card.classList.remove(...CARD_CLASSES);

    if (list.length === 0) {
        return;
    }

    const badge = buildThumbnailBadge(list);

    getOverlayLayer().appendChild(badge);
    thumbnailBadges.set(thumbnail, badge);
    positionBadge(thumbnail, badge);

    const mode = strictestMode(list);

    if (MODE_CLASS[mode]) {
        card.classList.add(MODE_CLASS[mode]);
    }
}

function scanEndscreenTiles(activeThumbnails) {
    getEndscreenTiles().forEach((tile) => {
        const href = getEndscreenHref(tile);
        const videoId = href ? getVideoIdFromHref(href) : null;

        if (!videoId) {
            return;
        }

        try {
            applyToThumbnail(tile, videoId, activeThumbnails);
        } catch (error) {
            logErr("CreatorBlock: could not draw a badge on this end-screen tile", error);
        }
    });
}

// YouTube reuses DOM elements as you scroll: a thumbnail that showed one
// video a moment ago can quietly become part of a different card (a
// Shorts tile is the common case) without us ever seeing a matching
// /watch link for it again. This removes any badge left behind on an
// element that wasn't just confirmed as a real, current video thumbnail.
function removeStaleBadges(activeThumbnails) {
    thumbnailBadges.forEach((badge, thumbnail) => {
        if (activeThumbnails.has(thumbnail) && document.contains(thumbnail)) {
            return;
        }

        try {
            badge.remove();
            thumbnailBadges.delete(thumbnail);

            delete thumbnail.dataset.creatorblockSig;

            const card = findCard(thumbnail) || thumbnail;
            card.classList.remove(...CARD_CLASSES);
        } catch (error) {
            logErr("CreatorBlock: could not clean up a stale badge", error);
        }
    });
}

function scanThumbnails() {
    const activeThumbnails = new Set();

    document.querySelectorAll('a[href*="/watch?"]').forEach((link) => {
        if (isShortsLink(link)) {
            return;
        }

        const thumbnail = findThumbnail(link);

        if (!thumbnail) {
            return;
        }

        const videoId = getVideoIdFromLink(link);

        if (!videoId) {
            return;
        }

        try {
            applyToThumbnail(thumbnail, videoId, activeThumbnails);
        } catch (error) {
            logErr("CreatorBlock: could not draw a badge on this thumbnail", error);
        }
    });

    scanEndscreenTiles(activeThumbnails);
    removeStaleBadges(activeThumbnails);
}


// ============================================================
// RUN WORK AT MOST A FEW TIMES PER SECOND
// (YouTube changes its DOM constantly)
// ============================================================

let scanQueued = false;

function scheduleScan() {
    if (scanQueued) {
        return;
    }

    scanQueued = true;

    setTimeout(() => {
        scanQueued = false;

        checkCurrentVideo();
        addCreatorButton();
        scanThumbnails();
        prefetchCommunityTags();
    }, 300);
}


// ============================================================
// THE TOOLBAR POPUP ASKS "WHO IS IN THE VIDEO I'M WATCHING?"
// ============================================================

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "creatorblock:getVideo") {
        return;
    }

    const videoId = getCurrentVideoId();

    sendResponse({
        videoId,
        creators: videoId
            ? getCreatorsForVideo(videoId).map((creator) => ({
                id: creator.id,
                name: creator.name,
                avatar: creator.avatar || "",
                handle: creator.handle || "",
                ownerConfirmed: creator.ownerConfirmed === true,
                adminLocked: creator.adminLocked === true
            }))
            : []
    });
});


// ============================================================
// START
// ============================================================

async function init() {
    await loadData();

    // Any click that reaches the document is outside the panel and
    // outside our button (both stop propagation), so close the panel.
    document.addEventListener("click", closePanel);

    checkCurrentVideo();
    addCreatorButton();
    scanThumbnails();
    prefetchCommunityTags();

    const observer = new MutationObserver(scheduleScan);

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // YouTube fires this when it finishes an in-page navigation (no
    // full page reload). Async work already in flight from before the
    // navigation - e.g. mid-await in fetchMissingCommunityTags - can
    // resume into a page that has since moved on. On Firefox that has
    // shown up as a generic, stack-less "Permission denied" exception
    // that moves to whichever await happened to be in flight at the
    // time. Bumping this counter on every navigation, and having that
    // async work check it, lets it notice and abandon itself cleanly
    // instead of resuming into a stale context.
    document.addEventListener("yt-navigate-finish", () => {
        navigationGeneration++;
        scheduleScan();
    });
}

init();
