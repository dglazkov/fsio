// The tabs the shell holds, as a pure function.
//
// This is the first thing in Pewter the *page* answers rather than the host.
// Everything before it — `repos`, `ext`, `run`, `shell`, `agent` — is a
// question about the machine, and the machine is where the answer is. A tab is
// not on disk anywhere: it exists because a page is open, and it stops
// existing when that page closes. So the page is the only party that can say
// what the tabs are, and every front end ends up asking it.
//
// It lives in `pewter` rather than in the shell because three parties need it:
// the page applies these for real, the host checks what a command line typed
// before it sends one, and the tests apply them without a browser. Nothing in
// here knows about a folder, a session, or an iframe — what a tab *shows* is
// mounted around this function, and what is in here is the list.
//
// One thing in here is not a tab and outlives them all: the **catalog** of
// files the page has custody of. A flung copy is the page's, so it survives a
// reload and its tabs do not, which makes `pewt files` the way to find one
// again (`files.show` puts it back in a tab). That asymmetry is deliberate —
// tabs are what a browser is showing, a held file is what a browser owns.
import { basename, mimeFor, safeRelPath } from "./files.js";
/** What is in a tab, in one word, for a strip chip and a terminal's column.
 *  Here rather than in either caller so the two never disagree about what a
 *  tab is called. */
export const bodyLabel = (body) => body.kind === "extension" ? body.name : body.kind === "file" ? body.path : "a copy this page holds";
/** Every method the page answers. The host's table is the authority on what
 *  exists (@fsio/pewt's ops.ts); this is the list that gets checked against
 *  it, the same way `METHODS` is for the host's own. */
export const PAGE_METHODS = [
    "tabs.list",
    "tabs.add",
    "tabs.update",
    "tabs.close",
    "tabs.focus",
    "files.open",
    "files.fling",
    "files.list",
    "files.show",
    "files.drop",
];
/** The page said no — no such tab, or a name that is not one. Distinct from a
 *  transport failure: the command arrived, was understood, and the answer was
 *  no. It reaches a terminal as a receipt with `ok: false`, never as an RPC
 *  error, because the RPC in question was answered fine by the host that
 *  forwarded it. */
export class TabError extends Error {
    code;
    hint;
    constructor(code, message, 
    /** what to do instead. Printed under the error, because an agent reading
     *  stderr can act on a hint and cannot act on a tone. */
    hint) {
        super(message);
        this.code = code;
        this.hint = hint;
        this.name = "TabError";
    }
}
export const newTabId = () => `tab-${Math.random().toString(16).slice(2, 10)}`;
const str = (params, key) => {
    const value = params[key];
    return typeof value === "string" && value !== "" ? value : null;
};
/** The two optional words every tab-making command takes, or null if one of
 *  them arrived as the wrong type. */
function opening(p) {
    const title = str(p, "title");
    const activate = p["activate"];
    if (activate !== undefined && typeof activate !== "boolean")
        return null;
    return { ...(title ? { title } : {}), ...(activate !== undefined ? { activate } : {}) };
}
/** What arrived → a command this page will apply, or null.
 *
 *  Both ends run this: the command line to turn what you typed into what
 *  travels, the page to check what arrived. The page checks because anything
 *  that can write the folder can write anything (spec/PROTOCOL.md, threat
 *  model) — the host forwarding a command is not a promise that it made sense
 *  of it. */
export function asTabCommand(method, params) {
    const p = (params ?? {});
    if (!params || typeof params !== "object")
        return null;
    switch (method) {
        case "tabs.list":
        case "files.list":
            return { method, params: {} };
        case "tabs.add": {
            const name = str(p, "name");
            const rest = opening(p);
            if (!name || !rest)
                return null;
            return { method, params: { name, ...rest } };
        }
        case "tabs.update": {
            const id = str(p, "id");
            const title = str(p, "title");
            return id && title ? { method, params: { id, title } } : null;
        }
        case "tabs.close":
        case "tabs.focus": {
            const id = str(p, "id");
            return id ? { method, params: { id } } : null;
        }
        case "files.open":
        case "files.fling": {
            // The path is normalized here, so what travels onward and what the page
            // applies are the same string. A path that climbs out of the pewter is
            // not a command at all — this is the check, and it runs on both ends.
            const path = safeRelPath(p["path"]);
            const rest = opening(p);
            if (!path || !rest)
                return null;
            return { method, params: { path, ...rest } };
        }
        case "files.show": {
            const id = str(p, "id");
            const rest = opening(p);
            return id && rest ? { method, params: { id, ...rest } } : null;
        }
        case "files.drop": {
            const id = str(p, "id");
            return id ? { method, params: { id } } : null;
        }
        default:
            return null;
    }
}
/** What a fresh shell holds: nothing, until it opens its first extension.
 *
 *  A pewter's first screen is `extensions/repos/`, and the shell opens it the
 *  same way a command line would — through `tabs.add`. There is no built-in
 *  tab for the same reason there is no built-in screen. The catalog is empty
 *  here too and is filled from browser storage at boot, because a copy the
 *  page took custody of last week is still the page's. */
export const noTabs = () => ({ tabs: [], activeId: null, held: [] });
/** Apply one command. Takes a state, returns the next state and what the
 *  caller should be told. Throws TabError when the page says no.
 *
 *  Two commands have work for their caller to do first, and both do it for the
 *  same reason — a tab committed before the thing it shows exists would be a
 *  strip entry pointing at nothing:
 *
 *    tabs.add     the extension has to build and be read out of the folder.
 *    files.fling  the file has to be read through the grant and stored, so a
 *                 browser that refuses to store it refuses the command
 *                 instead of leaving a catalog entry with no bytes behind it.
 *
 *  The page does both around this function (packages/pewter-shell/web/tabs.ts)
 *  and only gets here once the bytes are in hand. */
export function applyTabs(state, command, opts = {}) {
    const makeId = opts.makeId ?? newTabId;
    const tabs = state.tabs.map((t) => ({ ...t }));
    const held = state.held.map((h) => ({ ...h }));
    const find = (id) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) {
            throw new TabError("tab_not_found", `no tab with id ${JSON.stringify(id)}`, "run `pewt tabs` to see what this page is holding");
        }
        return tab;
    };
    const heldOr404 = (id) => {
        const file = held.find((h) => h.id === id);
        if (!file) {
            throw new TabError("file_not_held", `this page holds no copy with id ${JSON.stringify(id)}`, "run `pewt files` to see what it does hold");
        }
        return file;
    };
    /** A new tab, made the one way every command makes one. */
    const put = (title, body, params) => {
        const tab = { id: makeId(), title: params.title ?? title, body };
        tabs.push(tab);
        // The new tab comes forward unless it was asked not to. `activate: false`
        // is for the case something is stacking screens up for later; the ordinary
        // case is that you asked for a tab because you want to look at it.
        return { tab, active: params.activate !== false };
    };
    switch (command.method) {
        case "tabs.list":
            return { state: { tabs, activeId: state.activeId, held }, result: { tabs, activeId: state.activeId } };
        case "tabs.add": {
            const { name } = command.params;
            const { tab, active } = put(name, { kind: "extension", name }, command.params);
            return {
                state: { tabs, activeId: active ? tab.id : state.activeId, held },
                result: { id: tab.id, name, title: tab.title, active },
            };
        }
        case "tabs.update": {
            const tab = find(command.params.id);
            tab.title = command.params.title;
            return { state: { tabs, activeId: state.activeId, held }, result: { id: tab.id, title: tab.title } };
        }
        case "tabs.focus": {
            const tab = find(command.params.id);
            return { state: { tabs, activeId: tab.id, held }, result: { id: tab.id, title: tab.title } };
        }
        case "tabs.close": {
            find(command.params.id);
            const rest = tabs.filter((t) => t.id !== command.params.id);
            // Closing the tab on screen hands the stage to whatever is left, so the
            // page is never showing nothing while holding something. Closing a tab
            // onto a held copy does not drop the copy: the catalog is what the page
            // owns, and `pewt files show` puts it back.
            const activeId = state.activeId === command.params.id ? (rest[rest.length - 1]?.id ?? null) : state.activeId;
            return { state: { tabs: rest, activeId, held }, result: { id: command.params.id, activeId } };
        }
        case "files.open": {
            const { path } = command.params;
            // Opening the same file twice is a request to look at it, not to collect
            // tabs: the window already on it comes forward instead. A fling is the
            // opposite verb and does make a second tab, because a second copy is a
            // second thing.
            const shown = tabs.find((t) => t.body.kind === "file" && t.body.path === path);
            if (shown) {
                return { state: { tabs, activeId: shown.id, held }, result: { id: shown.id, path, title: shown.title, active: true, reused: true } };
            }
            const { tab, active } = put(basename(path), { kind: "file", path }, command.params);
            return {
                state: { tabs, activeId: active ? tab.id : state.activeId, held },
                result: { id: tab.id, path, title: tab.title, active, reused: false },
            };
        }
        case "files.fling": {
            const { path } = command.params;
            const measured = opts.flung;
            if (!measured)
                throw new TabError("internal", "a fling reached the rules with no bytes behind it");
            const name = basename(path);
            const makeFileId = opts.makeFileId ?? (() => `file-${Math.random().toString(16).slice(2, 10)}`);
            const now = opts.now ?? Date.now;
            // A second fling of the same path supersedes the first: you edited the
            // file and threw it again, and two snapshots of one path with no way to
            // tell them apart is worse than one that is current. A tab showing the
            // old copy follows it over; the caller drops the old blob.
            const previous = held.find((h) => h.from === path) ?? null;
            const file = { id: makeFileId(), name, from: path, type: measured.type || mimeFor(name), size: measured.size, at: now() };
            const catalog = [...held.filter((h) => h.id !== previous?.id), file];
            let tabId = null;
            for (const tab of tabs) {
                if (previous && tab.body.kind === "held" && tab.body.fileId === previous.id) {
                    tab.body = { kind: "held", fileId: file.id };
                    tab.title = command.params.title ?? file.name;
                    tabId = tab.id;
                }
            }
            let active = command.params.activate !== false;
            if (tabId === null) {
                const made = put(file.name, { kind: "held", fileId: file.id }, command.params);
                tabId = made.tab.id;
                active = made.active;
            }
            return {
                state: { tabs, activeId: active ? tabId : state.activeId, held: catalog },
                result: { fileId: file.id, id: tabId, name: file.name, from: file.from, size: file.size, type: file.type, superseded: previous?.id ?? null, active },
            };
        }
        case "files.list":
            return { state: { tabs, activeId: state.activeId, held }, result: { files: held } };
        case "files.show": {
            const file = heldOr404(command.params.id);
            const shown = tabs.find((t) => t.body.kind === "held" && t.body.fileId === file.id);
            if (shown) {
                return { state: { tabs, activeId: shown.id, held }, result: { id: shown.id, fileId: file.id, name: file.name, active: true, reused: true } };
            }
            const { tab, active } = put(file.name, { kind: "held", fileId: file.id }, command.params);
            return {
                state: { tabs, activeId: active ? tab.id : state.activeId, held },
                result: { id: tab.id, fileId: file.id, name: file.name, active, reused: false },
            };
        }
        case "files.drop": {
            const file = heldOr404(command.params.id);
            // Dropping the bytes closes the windows onto them: a held tab whose copy
            // is gone would be a viewer with nothing to view.
            const rest = tabs.filter((t) => !(t.body.kind === "held" && t.body.fileId === file.id));
            const activeId = rest.some((t) => t.id === state.activeId) ? state.activeId : (rest[rest.length - 1]?.id ?? null);
            return {
                state: { tabs: rest, activeId, held: held.filter((h) => h.id !== file.id) },
                result: { id: file.id, name: file.name, closedTabs: tabs.length - rest.length, activeId },
            };
        }
    }
}
//# sourceMappingURL=tabs.js.map