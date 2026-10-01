// ============================================================
// CreatorBlock toolbar popup
//
//   - the on/off switch
//   - who is in the video you're watching (set a filter in one click)
//   - what each filter does
//   - My Filters: the ONLY place creators are added to your filter
//     list. Tagging a creator in a video never adds them here.
//   - "I'm a creator": prove a channel is yours so your votes on your
//     own videos count more
// ============================================================

let creators = {};     // creators we know about (name, picture)
let filters = {};      // YOUR filter list: { channelId: "like" | "warn" | "dim" | "hide" }
let enabled = true;
let owned = [];        // channels you've proven you own: [{ channelId, name }]
let ownerWeight = 5;   // what the server says a creator's vote is worth

const $ = (id) => document.getElementById(id);


// ============================================================
// STORAGE
// ============================================================

async function loadState() {
    const data = await browser.storage.local.get(
        [KEY_CREATORS, KEY_FILTERS, KEY_ENABLED, KEY_OWNED]
    );

    creators = data[KEY_CREATORS] || {};
    filters = data[KEY_FILTERS] || {};
    enabled = data[KEY_ENABLED] !== false;
    owned = data[KEY_OWNED] || [];
}

// Puts a creator on your filter list (or changes their filter).
async function addToFilters(creator, mode) {
    if (!MODE_LIST.includes(mode)) {
        return;
    }

    // Read the latest copy first, so nothing the page just saved is lost.
    const data = await browser.storage.local.get([KEY_CREATORS, KEY_FILTERS]);
    const known = data[KEY_CREATORS] || {};
    const list = data[KEY_FILTERS] || {};

    known[creator.id] = {
        id: creator.id,
        name: creator.name,
        avatar: creator.avatar || "",
        handle: creator.handle || ""
    };

    list[creator.id] = mode;

    await browser.storage.local.set({ [KEY_CREATORS]: known, [KEY_FILTERS]: list });
}

async function takeOffFilters(creatorId) {
    const data = await browser.storage.local.get(KEY_FILTERS);
    const list = data[KEY_FILTERS] || {};

    delete list[creatorId];

    await browser.storage.local.set({ [KEY_FILTERS]: list });
}

// Asks the background script (which talks to the server).
async function askBackground(message) {
    const response = await browser.runtime.sendMessage(message);

    if (!response || !response.ok) {
        const error = new Error(
            (response && response.error) || "The extension didn't answer. Try again."
        );

        error.code = response && response.code;

        throw error;
    }

    return response.data;
}


// ============================================================
// SMALL PIECES
// ============================================================

function createChip(kind, text) {
    return el("span", "creatorblock-chip creatorblock-chip-" + kind, text);
}

// picture + name (+ a second line) on the left, whatever you pass on the right.
function createRow(creator, secondLine, controls) {
    const row = el("div", "pop-row");
    const text = el("div", "pop-row-text");

    text.appendChild(el("div", "pop-row-name", creator.name));

    if (secondLine) {
        text.appendChild(secondLine);
    }

    row.appendChild(createAvatar(creator));
    row.appendChild(text);

    (controls || []).forEach((control) => row.appendChild(control));

    return row;
}

function createRemoveButton(title, onClick) {
    const button = el("button", "pop-remove", "✕");

    button.type = "button";
    button.title = title;
    button.addEventListener("click", onClick);

    return button;
}


// ============================================================
// THE ON/OFF SWITCH
// ============================================================

function renderEnabled() {
    $("enabled").checked = enabled;
    $("enabledLabel").textContent = enabled ? "On" : "Paused";
    $("pausedNote").hidden = enabled;
}

$("enabled").addEventListener("change", () => {
    browser.storage.local.set({ [KEY_ENABLED]: $("enabled").checked });
});


// ============================================================
// WHAT THE FILTERS DO
// ============================================================

function renderLegend() {
    $("legendBody").replaceChildren(createModeLegend());
}


// ============================================================
// MY FILTERS
// ============================================================

function renderFilters() {
    const box = $("filtersBody");

    box.replaceChildren();

    const list = Object.keys(filters)
        .filter((id) => MODE_LIST.includes(filters[id]))
        .map((id) => creators[id] || { id, name: id, avatar: "", handle: "" })
        .sort((a, b) => a.name.localeCompare(b.name));

    if (list.length === 0) {
        box.appendChild(
            el(
                "div",
                "pop-empty",
                "Your list is empty. Search below to add a creator, or use “This video” above."
            )
        );
    }

    list.forEach((creator) => {
        box.appendChild(
            createRow(
                creator,
                createModeSelect(filters[creator.id], (mode) => {
                    if (mode) {
                        addToFilters(creator, mode);
                    }
                }),
                [createRemoveButton("Take off my filter list", () => takeOffFilters(creator.id))]
            )
        );
    });
}


// ============================================================
// THIS VIDEO
// ============================================================

let videoToken = 0;

async function renderVideo() {
    const token = ++videoToken;
    const box = $("videoBody");

    let info = null;

    try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tab = tabs && tabs[0];

        if (tab && tab.id !== undefined && /^https:\/\/www\.youtube\.com\//.test(tab.url || "")) {
            info = await browser.tabs.sendMessage(tab.id, { type: "creatorblock:getVideo" });
        }
    } catch (error) {
        info = null;   // no YouTube page here, or it needs a refresh
    }

    if (token !== videoToken) {
        return;
    }

    box.replaceChildren();

    if (!info || !info.videoId) {
        box.appendChild(
            el(
                "div",
                "pop-empty",
                "Open (or refresh) a YouTube video to see who is in it."
            )
        );
        return;
    }

    if (info.creators.length === 0) {
        box.appendChild(
            el(
                "div",
                "pop-empty",
                "Nobody is tagged in this video yet. Use the 👤 button on the video to add people."
            )
        );
        return;
    }

    info.creators.forEach((creator) => {
        const second = el("div", "pop-row-line");

        second.appendChild(
            createModeSelect(
                MODE_LIST.includes(filters[creator.id]) ? filters[creator.id] : "",
                (mode) => {
                    if (mode) {
                        addToFilters(creator, mode);
                    } else {
                        takeOffFilters(creator.id);
                    }
                },
                "Not in my filters"
            )
        );

        if (creator.ownerConfirmed) {
            second.appendChild(createChip("creator", "✓ confirmed by the creator"));
        }

        box.appendChild(createRow(creator, second));
    });
}


// ============================================================
// ADD A CREATOR TO MY FILTERS
// ============================================================

function setupAdd() {
    const body = $("addBody");

    const input = el("input", "pop-input");
    input.type = "text";
    input.placeholder = "Search by name, @handle, or paste a channel link";
    input.autocomplete = "off";

    const results = el("div", "pop-results");

    body.appendChild(input);
    body.appendChild(results);

    let timer = null;
    let token = 0;
    let state = { query: "", status: "idle", found: [], message: "" };
    let lookedUp = null;       // a channel found from a pasted link
    let lookupRunning = false;
    let notice = "";           // "Added X as ♥ Like"

    function isLinkLike(query) {
        return /^(https?:\/\/|www\.|(m\.)?youtube\.com)/i.test(query) ||
               /^UC[\w-]{22}$/.test(query);
    }

    async function add(creator, mode) {
        await addToFilters(creator, mode);

        notice = "Added " + creator.name + " as " + MODE_INFO[mode].icon + " " + MODE_INFO[mode].label + ".";
        input.value = "";
        lookedUp = null;
        state = { query: "", status: "idle", found: [], message: "" };
        render();
    }

    // Meta text (the @handle) and the "Add as..." control sit together in
    // one row under the name, the same way the other lists in this popup
    // do it. If the control were a sibling of the name instead, it would
    // stretch to the full row width and cover the name.
    function creatorRow(creator, metaText) {
        const line = el("div", "pop-row-line");

        if (metaText) {
            line.appendChild(el("span", "pop-row-meta", metaText));
        }

        const mode = MODE_LIST.includes(filters[creator.id]) ? filters[creator.id] : "";

        const control = mode
            ? createChip(mode, "In your list: " + MODE_INFO[mode].icon + " " + MODE_INFO[mode].label)
            : createModeSelect("", (chosen) => {
                if (chosen) {
                    add(creator, chosen);
                }
            }, "Add as…");

        line.appendChild(control);

        return createRow(creator, line);
    }

    function render() {
        const query = input.value.trim();

        results.replaceChildren();

        if (notice) {
            results.appendChild(el("div", "pop-notice", notice));
        }

        if (!query) {
            if (!notice) {
                results.appendChild(
                    el("div", "pop-hint", "Type a channel name or @handle, or paste a channel link.")
                );
            }

            return;
        }

        const lower = query.toLowerCase();
        const bare = lower.replace(/^@/, "");

        // Creators we already know about.
        const known = Object.values(creators).filter((creator) =>
            creator.name.toLowerCase().includes(lower) ||
            (creator.handle || "").toLowerCase().replace(/^@/, "").includes(bare)
        );

        if (toChannelUrl(query) && !lookedUp) {
            const lookup = el("button", "pop-lookup", "Look up “" + query + "”");

            lookup.type = "button";
            lookup.addEventListener("click", () => lookUp(query));

            results.appendChild(lookup);
        }

        if (lookedUp) {
            results.appendChild(creatorRow(lookedUp, lookedUp.handle));
        }

        known.forEach((creator) => {
            if (!lookedUp || creator.id !== lookedUp.id) {
                results.appendChild(creatorRow(creator, creator.handle));
            }
        });

        if (isLinkLike(query)) {
            return;
        }

        if (query.length < 2) {
            results.appendChild(el("div", "pop-hint", "Keep typing to search YouTube."));
            return;
        }

        if (state.query !== lower || state.status === "loading") {
            results.appendChild(el("div", "pop-hint", "Searching YouTube…"));
            return;
        }

        if (state.status === "error") {
            results.appendChild(el("div", "pop-error", state.message));
            return;
        }

        const knownIds = new Set(known.map((creator) => creator.id));
        const fresh = state.found.filter((creator) => !knownIds.has(creator.id));

        fresh.forEach((creator) => {
            results.appendChild(
                creatorRow(
                    creator,
                    [creator.handle, creator.subscribers].filter(Boolean).join(" · ")
                )
            );
        });

        if (fresh.length === 0 && known.length === 0 && !lookedUp) {
            results.appendChild(el("div", "pop-hint", "No channels found for “" + query + "”."));
        }
    }

    async function lookUp(query) {
        if (lookupRunning) {
            return;
        }

        lookupRunning = true;
        results.replaceChildren(el("div", "pop-hint", "Looking up channel…"));

        try {
            lookedUp = await fetchChannelInfo(query);
            render();
        } catch (error) {
            console.error("CreatorBlock: channel lookup failed", error);

            results.replaceChildren(
                el(
                    "div",
                    "pop-error",
                    error instanceof LookupError
                        ? error.message
                        : "Couldn't look up that channel. Try again in a moment."
                )
            );
        } finally {
            lookupRunning = false;
        }
    }

    async function runSearch(query, mine) {
        const lower = query.toLowerCase();

        try {
            const found = await searchChannels(query.replace(/^@/, ""));

            if (mine !== token) {
                return;
            }

            state = { query: lower, status: "done", found, message: "" };
        } catch (error) {
            console.error("CreatorBlock: channel search failed", error);

            if (mine !== token) {
                return;
            }

            state = {
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
        clearTimeout(timer);

        const mine = ++token;
        const query = input.value.trim();

        if (query.length < 2 || isLinkLike(query)) {
            state = { query: "", status: "idle", found: [], message: "" };
            return;
        }

        state = { query: query.toLowerCase(), status: "loading", found: [], message: "" };

        timer = setTimeout(() => runSearch(query, mine), immediate ? 0 : 500);
    }

    input.addEventListener("input", () => {
        notice = "";
        lookedUp = null;
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

    render();

    // Lets the rest of the popup redraw the results (e.g. after a filter changed).
    return render;
}


// ============================================================
// I'M A CREATOR
// ============================================================

function setupOwner() {
    const body = $("ownerBody");

    // "idle" -> "pick" (choose your channel) -> "code" (paste it, then verify)
    let step = "idle";
    let channel = null;
    let code = "";
    let message = "";
    let messageIsError = false;

    function setMessage(text, isError) {
        message = text;
        messageIsError = !!isError;
    }

    function ownedChannels() {
        return owned;
    }

    function render() {
        body.replaceChildren();

        body.appendChild(
            el(
                "p",
                "pop-text",
                "If you make YouTube videos, verify your channel to make your tags and votes on your own videos outweight other's votes"
                
            )
        );

        ownedChannels().forEach((item) => {
            body.appendChild(el("div", "pop-owned", "✓ Verified: " + (item.name || item.channelId)));
        });

        if (message) {
            body.appendChild(el("div", messageIsError ? "pop-error" : "pop-notice", message));
        }

        if (step === "idle") {
            const start = el("button", "pop-button", ownedChannels().length ? "Verify another channel" : "Verify my channel");

            start.type = "button";
            start.addEventListener("click", () => {
                step = "pick";
                setMessage("");
                render();
            });

            body.appendChild(start);
            return;
        }

        if (step === "pick") {
            renderPick();
            return;
        }

        renderCode();
    }

    // ---- step 1: find your channel ----

    function renderPick() {
        body.appendChild(el("div", "pop-step", "Step 1: find your channel"));

        const input = el("input", "pop-input");
        input.type = "text";
        input.placeholder = "Your channel name, @handle, or link";

        const results = el("div", "pop-results");
        const cancel = el("button", "pop-button pop-button-quiet", "Cancel");

        cancel.type = "button";
        cancel.addEventListener("click", () => {
            step = "idle";
            render();
        });

        body.appendChild(input);
        body.appendChild(results);
        body.appendChild(cancel);

        function showChoices(list) {
            results.replaceChildren();

            list.forEach((creator) => {
                const choose = el("button", "pop-button", "This is my channel");

                choose.type = "button";
                choose.addEventListener("click", () => startChallenge(creator));

                results.appendChild(
                    createRow(creator, creator.handle ? el("div", "pop-row-meta", creator.handle) : null, [choose])
                );
            });
        }

        async function find() {
            const query = input.value.trim();

            if (query.length < 2) {
                return;
            }

            results.replaceChildren(el("div", "pop-hint", "Searching…"));

            try {
                if (toChannelUrl(query)) {
                    showChoices([await fetchChannelInfo(query)]);
                } else {
                    const found = await searchChannels(query.replace(/^@/, ""));

                    if (found.length === 0) {
                        results.replaceChildren(el("div", "pop-hint", "No channels found."));
                    } else {
                        showChoices(found);
                    }
                }
            } catch (error) {
                results.replaceChildren(
                    el("div", "pop-error", error instanceof LookupError ? error.message : "Couldn't search right now.")
                );
            }
        }

        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                find();
            }
        });
    }

    async function startChallenge(creator) {
        try {
            const data = await askBackground({ type: "ownerChallenge", channelId: creator.id });

            channel = creator;
            code = data.code;
            ownerWeight = data.weight || ownerWeight;
            step = "code";
            setMessage("");
        } catch (error) {
            setMessage(error.message, true);
            step = "idle";
        }

        render();
    }

    // ---- step 2: put the code in a description, then verify ----

    function renderCode() {
        body.appendChild(el("div", "pop-step", "Step 2: prove it's " + channel.name));

        body.appendChild(el("div", "pop-code", code));

        const copy = el("button", "pop-button pop-button-quiet", "Copy code");

        copy.type = "button";
        copy.addEventListener("click", () => {
            try {
                navigator.clipboard.writeText(code);
                copy.textContent = "Copied";
            } catch (error) {
                copy.textContent = "Select and copy it";
            }
        });

        body.appendChild(copy);

        body.appendChild(
            el(
                "p",
                "pop-text",
                "Open YouTube Studio, edit the description of one of your channel's 15 latest videos, " +
                "paste the code anywhere in it, and save. Wait a minute, then press Verify. " +
                "You can delete the code afterwards. The code works for 2 hours."
            )
        );

        const verify = el("button", "pop-button", "Verify");
        const cancel = el("button", "pop-button pop-button-quiet", "Cancel");

        verify.type = "button";
        cancel.type = "button";

        verify.addEventListener("click", async () => {
            verify.disabled = true;
            verify.textContent = "Checking…";

            try {
                const data = await askBackground({ type: "ownerVerify", channelId: channel.id });

                ownerWeight = data.weight || ownerWeight;

                const list = owned.filter((item) => item.channelId !== data.channelId);
                list.push({ channelId: data.channelId, name: data.name || channel.name });

                owned = list;
                await browser.storage.local.set({ [KEY_OWNED]: list });

                step = "idle";
                setMessage("Verified. Your votes on " + (data.name || channel.name) + "'s videos now count as " + ownerWeight + ".");
            } catch (error) {
                setMessage(error.message, true);
            }

            render();
        });

        cancel.addEventListener("click", () => {
            step = "idle";
            setMessage("");
            render();
        });

        body.appendChild(verify);
        body.appendChild(cancel);
    }

    render();

    return render;
}


// ============================================================
// ADMIN
// Your admin key, entered once per device. It is stored only in this
// browser's local extension storage. Every tag or vote you make from
// this device is then sent with it, so the server treats it as final
// — until you (the admin) change your mind, or clear the key here.
// ============================================================

function setupAdmin() {
    const body = $("adminBody");

    let key = "";
    let message = "";

    function render() {
        body.replaceChildren();

        body.appendChild(
            el(
                "p",
                "pop-text",
                "If you set your admin key here, every tag, confirm (✓) or " +
                "remove (✕) you do from this device becomes final: the " +
                "community's votes can no longer change it. You can still " +
                "undo it yourself at any time. This is separate from the " +
                "creator verification above, and only works where the " +
                "server has the same key configured."
            )
        );

        if (key) {
            body.appendChild(el("div", "pop-owned", "🔒 Admin mode is on for this device."));
        }

        const input = el("input", "pop-input");
        input.type = "password";
        input.placeholder = "Admin key";
        input.value = key;

        const save = el("button", "pop-button", key ? "Update key" : "Save key");
        const clear = el("button", "pop-button pop-button-quiet", "Clear");

        save.type = "button";
        clear.type = "button";

        save.addEventListener("click", async () => {
            const value = input.value.trim();

            if (!value) {
                return;
            }

            await browser.storage.local.set({ [KEY_ADMIN_KEY]: value });

            key = value;
            message = "Saved. Admin mode is on for this device.";
            render();
        });

        clear.addEventListener("click", async () => {
            await browser.storage.local.remove(KEY_ADMIN_KEY);

            key = "";
            message = "Cleared. This device is back to ordinary votes.";
            render();
        });

        body.appendChild(input);
        body.appendChild(save);

        if (key) {
            body.appendChild(clear);
        }

        if (message) {
            body.appendChild(el("div", "pop-notice", message));
        }
    }

    browser.storage.local.get(KEY_ADMIN_KEY).then((data) => {
        key = data[KEY_ADMIN_KEY] || "";
        render();
    });

    render();
}


// ============================================================
// START
// ============================================================

let renderOwner = null;

async function start() {
    await loadState();

    renderEnabled();
    renderLegend();
    renderFilters();

    setupAdd();
    renderOwner = setupOwner();
    setupAdmin();

    renderVideo();

    // Keep in step with changes made anywhere (this popup, the page, other tabs).
    browser.storage.onChanged.addListener(async (changes, area) => {
        if (area !== "local") {
            return;
        }

        await loadState();

        renderEnabled();
        renderFilters();
        renderVideo();
    });

    // Refresh the list of channels you've proven you own (quietly).
    try {
        const data = await askBackground({ type: "ownerMine" });

        ownerWeight = data.weight || ownerWeight;
        owned = data.channels || [];

        await browser.storage.local.set({ [KEY_OWNED]: owned });

        if (renderOwner) {
            renderOwner();
        }
    } catch (error) {
        // Offline, or the server isn't set up yet. The saved list is used.
    }
}

start();
