// The mock application, as a pure function.
//
// It lives in src/ rather than web/ because both sides need it: the page
// applies operations for real, and the tests apply them without a browser.
// Nothing in here knows about the folder, the session, or the CLI — the
// whole point of the actuator pattern is that the thing being actuated is
// an ordinary application that happens to accept commands from elsewhere.

/** What a tab is showing. Three kinds, and the difference between the last
 *  two is the demo's second act:
 *
 *  message — text that arrived with the command. Nothing else exists.
 *  local   — a file in the granted folder, read live by the page every time
 *            it renders. The page holds a *path*; the bytes stay on disk,
 *            and editing the file in your editor changes the tab.
 *  held    — a copy the page has custody of, in IndexedDB. It keeps working
 *            with the helper stopped and the folder grant revoked, and it
 *            is a snapshot: it says what the file said when it was flung.
 *
 *  No tab kind stores file *contents* in application state. Local tabs read
 *  from disk and held tabs read from a blob store, both keyed by what is in
 *  here — which is what keeps this state small, serializable, and honest
 *  about where each byte actually lives. */
export type TabBody =
  | { kind: "message"; message: string }
  | { kind: "local"; path: string }
  | { kind: "held"; fileId: string };

export interface Tab {
  id: string;
  title: string;
  body: TabBody;
}

/** One file the page has custody of. The bytes are in a blob store beside
 *  this catalog (web/db.ts); everything a list needs is here, so the
 *  sidebar and `actuator files list` never open a blob to render a row. */
export interface HeldFile {
  id: string;
  /** basename, as it was flung. */
  name: string;
  /** where it came from on the machine — provenance, and what a re-fling
   *  supersedes on. Informational to the page: it cannot read it. */
  from: string;
  type: string;
  size: number;
  /** when it landed here. */
  at: number;
}

export interface AppState {
  tabs: Tab[];
  activeId: string | null;
  held: HeldFile[];
}

/** The verbs, as they arrive on the wire. The CLI parses argv into one of
 *  these; the page switches on `method`. */
export type Operation =
  | { method: "tabs.add"; params: { title: string; message: string; activate?: boolean } }
  | { method: "tabs.remove"; params: { id: string } }
  | { method: "tabs.activate"; params: { id: string } }
  | { method: "tabs.update"; params: { id: string; title?: string; message?: string } }
  | { method: "tabs.list"; params: Record<string, never> }
  /** Look at a file in the folder you granted. Only the path travels. */
  | { method: "files.open"; params: { path: string } }
  /** Hand the page a copy. The bytes travel, base64 in `data`, and the page
   *  owns them afterwards. `from` is where they came from, for the record. */
  | {
      method: "files.fling";
      params: { name: string; from: string; type: string; size: number; data: string; open?: boolean };
    }
  | { method: "files.list"; params: Record<string, never> }
  /** Put a held file in a tab — what `fling --no-open` deferred. */
  | { method: "files.show"; params: { id: string } }
  | { method: "files.drop"; params: { id: string } };

export const METHODS: Operation["method"][] = [
  "tabs.add",
  "tabs.remove",
  "tabs.activate",
  "tabs.update",
  "tabs.list",
  "files.open",
  "files.fling",
  "files.list",
  "files.show",
  "files.drop",
];

/** The largest file this demo will fling. Chosen, not measured: one frame
 *  carries it (the framing's length is a u32, and the file-chunk lane is
 *  the always-works one — spec/PROTOCOL.md), and a megabyte is more than a
 *  demo needs while staying a size a page can hold without thinking about
 *  it. A bigger file is a refusal with a number in it, never a hang. */
export const MAX_FLING_BYTES = 1024 * 1024;

/** An application-level refusal — the tab does not exist, say. Distinct from
 *  a transport failure: this one travelled fine and the answer was no. It
 *  reaches the CLI as a receipt with `ok: false`, never as an RPC error. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** what to do instead. The CLI prints it under the error, because an
     *  agent reading stderr can act on a hint and cannot act on a tone. */
    readonly hint?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const newTabId = (): string => `tab-${Math.random().toString(16).slice(2, 10)}`;
export const newFileId = (): string => `file-${Math.random().toString(16).slice(2, 10)}`;

/** A folder-relative path, or null if it is not one this page may open.
 *
 *  The page's reach is exactly the folder it was granted, so a path that
 *  climbs out of it, starts at the root, or names a drive is refused here
 *  rather than resolved and refused later by Chrome. Both ends run this:
 *  the CLI to turn what you typed into what travels, the page to check what
 *  arrived ("anything that can write the folder can write anything" —
 *  spec/PROTOCOL.md, threat model). */
export function safeRelPath(input: string): string | null {
  if (typeof input !== "string" || input === "") return null;
  if (input.startsWith("/") || /^[a-zA-Z]:/.test(input)) return null;
  if (input.includes("\0") || input.includes("\\")) return null;
  const parts = input.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

export const basename = (path: string): string => path.split("/").pop() || path;

const TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown",
  json: "application/json", jsonl: "application/json",
  js: "text/javascript", mjs: "text/javascript", ts: "text/typescript",
  css: "text/css", html: "text/html", xml: "text/xml", yml: "text/yaml", yaml: "text/yaml",
  csv: "text/csv", log: "text/plain", sh: "text/plain", toml: "text/plain",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
  pdf: "application/pdf",
};

/** A guess from the extension. The CLI makes it (it is the side holding the
 *  file) and the page believes it — a demo's viewer choice is not a security
 *  boundary, and sniffing content would be a bigger lie than the extension. */
export function mimeFor(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

/** Which viewer a body gets. Text and image are the two this demo has;
 *  everything else says so rather than rendering mojibake. The list is
 *  where a third viewer would be added, and the tab renderer is the only
 *  other place that would change. */
export function viewerFor(type: string): "text" | "image" | "none" {
  if (type === "image/svg+xml" || type === "application/json") return "text";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/")) return "text";
  return "none";
}

/** What a fresh page shows: one tab that explains what it is. A page with
 *  nothing in it cannot tell you it is waiting for a CLI (P6 — the page is
 *  a working app before anything actuates it). */
export function initialState(): AppState {
  return {
    tabs: [
      {
        id: "welcome",
        title: "Welcome",
        body: {
          kind: "message",
          message:
            "This page owns its own state. Nothing here came from a server — it came from a terminal on this machine, through the folder you granted.\n\n" +
            "Try, in that folder:\n\n" +
            '  actuator tabs add --title Build --message "CI is running"\n' +
            "  actuator open notes.md        — the page reads it where it lies\n" +
            "  actuator fling ~/photo.png    — the page keeps a copy of its own\n\n" +
            "The difference is the point. An opened file is a view: it lives on your disk and the tab goes dark when the folder does. A flung file is the page's: stop the helper, revoke the grant, and it is still here.",
        },
      },
    ],
    activeId: "welcome",
    held: [],
  };
}

/** The catalog entry, or the refusal that names the way to find the right
 *  id. Both file operations that take one need the same sentence. */
function heldOr404(held: HeldFile[], id: string): HeldFile {
  const file = held.find((h) => h.id === id);
  if (!file) {
    throw new AppError(
      "file_not_held",
      `this page holds no file with id ${JSON.stringify(id)}`,
      "run `actuator files list` to see what it does hold"
    );
  }
  return file;
}

export interface ApplyOptions {
  makeId?: () => string;
  makeFileId?: () => string;
  now?: () => number;
}

/** Apply one operation. Pure: takes a state, returns the next state and
 *  whatever the CLI should be told. Throws AppError when the app says no.
 *
 *  The ids and the clock are parameters so tests get stable output without
 *  stubbing crypto or time.
 *
 *  `files.fling` is the one operation whose params carry more than this
 *  function reads: the bytes are in `data`, and nothing here touches them.
 *  Application state never holds file contents — the caller writes the blob
 *  under the `fileId` in the result, and does it *before* committing this
 *  state, so a store that refuses cannot leave a catalog entry pointing at
 *  nothing (web/db.ts). */
export function apply(
  state: AppState,
  op: Operation,
  opts: ApplyOptions = {}
): { state: AppState; result: Record<string, unknown> } {
  const makeId = opts.makeId ?? newTabId;
  const makeFileId = opts.makeFileId ?? newFileId;
  const now = opts.now ?? Date.now;

  const tabs = state.tabs.map((t) => ({ ...t }));
  const held = state.held.map((h) => ({ ...h }));
  const find = (id: string): Tab => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) {
      throw new AppError("tab_not_found", `no tab with id ${JSON.stringify(id)}`, "run `actuator tabs list` to see the ids this page holds");
    }
    return tab;
  };

  switch (op.method) {
    case "tabs.add": {
      const tab: Tab = { id: makeId(), title: op.params.title, body: { kind: "message", message: op.params.message } };
      const activate = op.params.activate !== false;
      tabs.push(tab);
      return {
        state: { tabs, activeId: activate ? tab.id : state.activeId, held },
        result: { id: tab.id, title: tab.title, active: activate },
      };
    }
    case "tabs.remove": {
      find(op.params.id);
      const rest = tabs.filter((t) => t.id !== op.params.id);
      // Removing the active tab hands focus to whatever is left, so the
      // page is never showing nothing while holding something.
      const activeId = state.activeId === op.params.id ? (rest[0]?.id ?? null) : state.activeId;
      return { state: { tabs: rest, activeId, held }, result: { id: op.params.id, activeId } };
    }
    case "tabs.activate": {
      const tab = find(op.params.id);
      return { state: { tabs, activeId: tab.id, held }, result: { id: tab.id, title: tab.title } };
    }
    case "tabs.update": {
      const tab = find(op.params.id);
      if (op.params.message !== undefined) {
        // A file tab's text is the file's, not the command's. Renaming one
        // is fine; rewriting what it shows would make the tab a liar.
        if (tab.body.kind !== "message") {
          throw new AppError(
            "not_a_message_tab",
            `tab ${tab.id} is showing a file, so its text is not a command's to set`,
            "`actuator open` re-reads a folder file; `actuator fling` replaces a held copy"
          );
        }
        tab.body = { kind: "message", message: op.params.message };
      }
      if (op.params.title !== undefined) tab.title = op.params.title;
      return { state: { tabs, activeId: state.activeId, held }, result: { id: tab.id, title: tab.title } };
    }
    case "tabs.list":
      return { state: { tabs, activeId: state.activeId, held }, result: { tabs, activeId: state.activeId } };

    case "files.open": {
      const path = safeRelPath(op.params.path);
      if (!path) {
        throw new AppError(
          "bad_path",
          `${JSON.stringify(op.params.path)} is not a path inside the granted folder`,
          "the page can only look inside the one folder you handed it — `actuator fling` hands it a copy of anything else"
        );
      }
      // Opening the same file twice is a request to look at it, not to
      // collect tabs: the existing view comes forward instead.
      const shown = tabs.find((t) => t.body.kind === "local" && t.body.path === path);
      if (shown) {
        return { state: { tabs, activeId: shown.id, held }, result: { id: shown.id, path, reused: true } };
      }
      const tab: Tab = { id: makeId(), title: basename(path), body: { kind: "local", path } };
      tabs.push(tab);
      return { state: { tabs, activeId: tab.id, held }, result: { id: tab.id, path, reused: false } };
    }

    case "files.fling": {
      const { name, from, type, size } = op.params;
      if (!name || !from) throw new AppError("bad_file", "a flung file needs a name and a source path");
      if (size > MAX_FLING_BYTES) {
        throw new AppError(
          "too_big",
          `${name} is ${size} bytes; this demo carries at most ${MAX_FLING_BYTES}`,
          "if it is inside the granted folder, `actuator open` shows it without moving it"
        );
      }
      // A second fling of the same source supersedes the first: you edited
      // the file and threw it again, and two snapshots of one path with no
      // way to tell them apart is worse than one that is current. A tab
      // showing the old copy follows it over; the caller drops the blob.
      const previous = held.find((h) => h.from === from) ?? null;
      const file: HeldFile = { id: makeFileId(), name, from, type, size, at: now() };
      const catalog = [...held.filter((h) => h.id !== previous?.id), file];
      let tabId: string | null = null;
      let activeId = state.activeId;
      for (const tab of tabs) {
        if (previous && tab.body.kind === "held" && tab.body.fileId === previous.id) {
          tab.body = { kind: "held", fileId: file.id };
          tab.title = file.name;
          tabId = tab.id;
        }
      }
      const opening = op.params.open !== false;
      if (opening) {
        if (tabId === null) {
          const tab: Tab = { id: makeId(), title: file.name, body: { kind: "held", fileId: file.id } };
          tabs.push(tab);
          tabId = tab.id;
        }
        activeId = tabId;
      }
      return {
        state: { tabs, activeId, held: catalog },
        result: {
          fileId: file.id,
          id: tabId,
          name: file.name,
          size: file.size,
          type: file.type,
          superseded: previous?.id ?? null,
          opened: opening,
        },
      };
    }

    case "files.list":
      return { state: { tabs, activeId: state.activeId, held }, result: { files: held } };

    case "files.show": {
      const file = heldOr404(held, op.params.id);
      const shown = tabs.find((t) => t.body.kind === "held" && t.body.fileId === file.id);
      if (shown) {
        return { state: { tabs, activeId: shown.id, held }, result: { id: shown.id, name: file.name, reused: true } };
      }
      const tab: Tab = { id: makeId(), title: file.name, body: { kind: "held", fileId: file.id } };
      tabs.push(tab);
      return { state: { tabs, activeId: tab.id, held }, result: { id: tab.id, name: file.name, reused: false } };
    }

    case "files.drop": {
      const file = heldOr404(held, op.params.id);
      // Dropping the bytes closes the windows onto them: a held tab whose
      // file is gone would be a viewer with nothing to view.
      const rest = tabs.filter((t) => !(t.body.kind === "held" && t.body.fileId === file.id));
      const activeId = rest.some((t) => t.id === state.activeId) ? state.activeId : (rest[0]?.id ?? null);
      return {
        state: { tabs: rest, activeId, held: held.filter((h) => h.id !== file.id) },
        result: { id: file.id, name: file.name, closedTabs: tabs.length - rest.length, activeId },
      };
    }
  }
}
