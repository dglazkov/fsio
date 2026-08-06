import { type HeldFile } from "./files.js";
/** What a tab is showing. Three kinds, and the last two are the difference
 *  `pewt open` and `pewt fling` exist to make:
 *
 *  extension — code out of the folder, bundled by the host and run in a frame
 *              with an origin of its own.
 *  file      — a window on a file in the pewter. The page holds a *path* and
 *              reads it through the grant; edit the file and the tab follows,
 *              delete it and the tab says so.
 *  held      — a copy the page has custody of, in browser storage. It keeps
 *              working with the file deleted, the host stopped and the grant
 *              revoked, and it is a snapshot: it says what the file said when
 *              it was flung.
 *
 *  No tab kind holds file *contents*. Both file kinds are references, which is
 *  what keeps this state small, serializable, and honest about where each byte
 *  actually lives. */
export type TabBody = {
    kind: "extension";
    name: string;
} | {
    kind: "file";
    path: string;
} | {
    kind: "held";
    fileId: string;
};
export interface Tab {
    id: string;
    /** what the strip calls it. Starts as the extension's name or the file's
     *  and can be renamed — `pewt tabs update` is the one page operation that
     *  changes nothing but a word. */
    title: string;
    body: TabBody;
}
/** What is in a tab, in one word, for a strip chip and a terminal's column.
 *  Here rather than in either caller so the two never disagree about what a
 *  tab is called. */
export declare const bodyLabel: (body: TabBody) => string;
/** Everything the page holds. Small and serializable on purpose: no bundle
 *  bytes, no file contents, no frame, no DOM. The iframe showing a tab is
 *  keyed by its id and lives beside this, and so are the blobs behind the
 *  catalog, because a state a test cannot construct is a state the tests stop
 *  covering. */
export interface TabsState {
    tabs: Tab[];
    /** the tab on screen, or null when the page holds none. */
    activeId: string | null;
    /** the files this page has custody of. Outlives the tabs: a reload loses
     *  every tab and keeps every copy. */
    held: HeldFile[];
}
/** What `tabs.list` answers — the strip, without the catalog. `pewt files` is
 *  the question about the catalog, and an operation that answered both would
 *  make one of them impossible to ask on its own. */
export interface TabsListing {
    tabs: Tab[];
    activeId: string | null;
}
/** The page's operations, as they arrive on the wire. The command line parses
 *  argv into one of these; the page switches on `method`.
 *
 *  The `files.*` half spells the two file verbs the way the wire does. A
 *  terminal types `pewt open` and an extension calls `pewt.open()`, because
 *  each front end has its own conventions — the operation does not. */
export type TabCommand = {
    method: "tabs.list";
    params: Record<string, never>;
}
/** Open an extension in a new tab. Twice means two tabs: `add` is a verb
 *  about the strip, and the way to bring an open one forward is `focus`. */
 | {
    method: "tabs.add";
    params: {
        name: string;
        title?: string;
        activate?: boolean;
    };
} | {
    method: "tabs.update";
    params: {
        id: string;
        title: string;
    };
} | {
    method: "tabs.close";
    params: {
        id: string;
    };
} | {
    method: "tabs.focus";
    params: {
        id: string;
    };
}
/** A window on a file in the pewter. Twice is once: opening the same path
 *  again is a request to look at it, not to collect tabs. */
 | {
    method: "files.open";
    params: {
        path: string;
        title?: string;
        activate?: boolean;
    };
}
/** A copy of a file in the pewter, taken into the page's custody. */
 | {
    method: "files.fling";
    params: {
        path: string;
        title?: string;
        activate?: boolean;
    };
} | {
    method: "files.list";
    params: Record<string, never>;
}
/** Put a copy the page already holds back in a tab. */
 | {
    method: "files.show";
    params: {
        id: string;
        title?: string;
        activate?: boolean;
    };
}
/** Forget a copy. Its tabs go with it — a viewer with nothing to view is
 *  worse than a tab that closed. */
 | {
    method: "files.drop";
    params: {
        id: string;
    };
};
/** Every method the page answers. The host's table is the authority on what
 *  exists (@fsio/pewt's ops.ts); this is the list that gets checked against
 *  it, the same way `METHODS` is for the host's own. */
export declare const PAGE_METHODS: TabCommand["method"][];
/** The page said no — no such tab, or a name that is not one. Distinct from a
 *  transport failure: the command arrived, was understood, and the answer was
 *  no. It reaches a terminal as a receipt with `ok: false`, never as an RPC
 *  error, because the RPC in question was answered fine by the host that
 *  forwarded it. */
export declare class TabError extends Error {
    readonly code: string;
    /** what to do instead. Printed under the error, because an agent reading
     *  stderr can act on a hint and cannot act on a tone. */
    readonly hint?: string | undefined;
    constructor(code: string, message: string, 
    /** what to do instead. Printed under the error, because an agent reading
     *  stderr can act on a hint and cannot act on a tone. */
    hint?: string | undefined);
}
export declare const newTabId: () => string;
/** What arrived → a command this page will apply, or null.
 *
 *  Both ends run this: the command line to turn what you typed into what
 *  travels, the page to check what arrived. The page checks because anything
 *  that can write the folder can write anything (spec/PROTOCOL.md, threat
 *  model) — the host forwarding a command is not a promise that it made sense
 *  of it. */
export declare function asTabCommand(method: string, params: unknown): TabCommand | null;
/** What a fresh shell holds: nothing, until it opens its first extension.
 *
 *  A pewter's first screen is `extensions/repos/`, and the shell opens it the
 *  same way a command line would — through `tabs.add`. There is no built-in
 *  tab for the same reason there is no built-in screen. The catalog is empty
 *  here too and is filled from browser storage at boot, because a copy the
 *  page took custody of last week is still the page's. */
export declare const noTabs: () => TabsState;
export interface ApplyOptions {
    /** the ids are a parameter so tests get stable output without stubbing
     *  crypto. */
    makeId?: () => string;
    makeFileId?: () => string;
    now?: () => number;
    /** what the page measured about the file it just read, for `files.fling`.
     *  The bytes are already in browser storage by the time this runs; a pure
     *  function cannot open a file, so its size and type arrive here. */
    flung?: {
        type: string;
        size: number;
    };
}
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
export declare function applyTabs(state: TabsState, command: TabCommand, opts?: ApplyOptions): {
    state: TabsState;
    result: Record<string, unknown>;
};
//# sourceMappingURL=tabs.d.ts.map