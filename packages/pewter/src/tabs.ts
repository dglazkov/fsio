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

/** What a tab is showing.
 *
 *  One kind today: an extension out of the folder. `pewt open` and `pewt
 *  fling` add the other two — a view of a file read through the grant, and a
 *  copy the browser holds — and they are the next slice
 *  (https://github.com/dglazkov/fsio/issues/164). This is a union of one on
 *  purpose: a tab that is only ever an extension would not need a `kind`, and
 *  writing it as though it were would make the second kind a rewrite. */
export type TabBody = { kind: "extension"; name: string };

export interface Tab {
  id: string;
  /** what the strip calls it. Starts as the extension's name and can be
   *  renamed — `pewt tabs update` is the one page operation that changes
   *  nothing but a word. */
  title: string;
  body: TabBody;
}

/** Everything the page holds. Small and serializable on purpose: no bundle
 *  bytes, no frame, no DOM. The iframe showing a tab is keyed by its id and
 *  lives beside this, because a state a test cannot construct is a state the
 *  tests stop covering. */
export interface TabsState {
  tabs: Tab[];
  /** the tab on screen, or null when the page holds none. */
  activeId: string | null;
}

/** The page's operations, as they arrive on the wire. The command line parses
 *  argv into one of these; the page switches on `method`. */
export type TabCommand =
  | { method: "tabs.list"; params: Record<string, never> }
  /** Open an extension in a new tab. Twice means two tabs: `add` is a verb
   *  about the strip, and the way to bring an open one forward is `focus`. */
  | { method: "tabs.add"; params: { name: string; title?: string; activate?: boolean } }
  | { method: "tabs.update"; params: { id: string; title: string } }
  | { method: "tabs.close"; params: { id: string } }
  | { method: "tabs.focus"; params: { id: string } };

/** Every method the page answers. The host's table is the authority on what
 *  exists (@fsio/pewt's ops.ts); this is the list that gets checked against
 *  it, the same way `METHODS` is for the host's own. */
export const PAGE_METHODS: TabCommand["method"][] = ["tabs.list", "tabs.add", "tabs.update", "tabs.close", "tabs.focus"];

/** The page said no — no such tab, or a name that is not one. Distinct from a
 *  transport failure: the command arrived, was understood, and the answer was
 *  no. It reaches a terminal as a receipt with `ok: false`, never as an RPC
 *  error, because the RPC in question was answered fine by the host that
 *  forwarded it. */
export class TabError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** what to do instead. Printed under the error, because an agent reading
     *  stderr can act on a hint and cannot act on a tone. */
    readonly hint?: string
  ) {
    super(message);
    this.name = "TabError";
  }
}

export const newTabId = (): string => `tab-${Math.random().toString(16).slice(2, 10)}`;

const str = (params: Record<string, unknown>, key: string): string | null => {
  const value = params[key];
  return typeof value === "string" && value !== "" ? value : null;
};

/** What arrived → a command this page will apply, or null.
 *
 *  Both ends run this: the command line to turn what you typed into what
 *  travels, the page to check what arrived. The page checks because anything
 *  that can write the folder can write anything (spec/PROTOCOL.md, threat
 *  model) — the host forwarding a command is not a promise that it made sense
 *  of it. */
export function asTabCommand(method: string, params: unknown): TabCommand | null {
  const p = (params ?? {}) as Record<string, unknown>;
  if (!params || typeof params !== "object") return null;
  switch (method) {
    case "tabs.list":
      return { method, params: {} };
    case "tabs.add": {
      const name = str(p, "name");
      if (!name) return null;
      const title = str(p, "title");
      const activate = p["activate"];
      if (activate !== undefined && typeof activate !== "boolean") return null;
      return {
        method,
        params: { name, ...(title ? { title } : {}), ...(activate !== undefined ? { activate } : {}) },
      };
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
    default:
      return null;
  }
}

/** What a fresh shell holds: nothing, until it opens its first extension.
 *
 *  A pewter's first screen is `extensions/repos/`, and the shell opens it the
 *  same way a command line would — through `tabs.add`. There is no built-in
 *  tab for the same reason there is no built-in screen. */
export const noTabs = (): TabsState => ({ tabs: [], activeId: null });

export interface ApplyOptions {
  /** the ids are a parameter so tests get stable output without stubbing
   *  crypto. */
  makeId?: () => string;
}

/** Apply one command. Takes a state, returns the next state and what the
 *  caller should be told. Throws TabError when the page says no.
 *
 *  `tabs.add` is the one command whose caller has work to do first: an
 *  extension has to be built and read before there is anything to show, and a
 *  tab committed before that would be a strip entry pointing at nothing. The
 *  page does that around this function and only gets here once the bytes are
 *  in hand (packages/pewter-shell/web/tabs.ts). */
export function applyTabs(state: TabsState, command: TabCommand, opts: ApplyOptions = {}): { state: TabsState; result: Record<string, unknown> } {
  const makeId = opts.makeId ?? newTabId;
  const tabs = state.tabs.map((t) => ({ ...t }));
  const find = (id: string): Tab => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) {
      throw new TabError("tab_not_found", `no tab with id ${JSON.stringify(id)}`, "run `pewt tabs` to see what this page is holding");
    }
    return tab;
  };

  switch (command.method) {
    case "tabs.list":
      return { state: { tabs, activeId: state.activeId }, result: { tabs, activeId: state.activeId } };

    case "tabs.add": {
      const { name, title, activate } = command.params;
      const tab: Tab = { id: makeId(), title: title ?? name, body: { kind: "extension", name } };
      tabs.push(tab);
      // The new tab comes forward unless it was asked not to. `--no-focus` is
      // for the case a terminal is stacking screens up for later; the ordinary
      // case is that you asked for a tab because you want to look at it.
      const active = activate !== false;
      return {
        state: { tabs, activeId: active ? tab.id : state.activeId },
        result: { id: tab.id, name, title: tab.title, active },
      };
    }

    case "tabs.update": {
      const tab = find(command.params.id);
      tab.title = command.params.title;
      return { state: { tabs, activeId: state.activeId }, result: { id: tab.id, title: tab.title } };
    }

    case "tabs.focus": {
      const tab = find(command.params.id);
      return { state: { tabs, activeId: tab.id }, result: { id: tab.id, title: tab.title } };
    }

    case "tabs.close": {
      find(command.params.id);
      const rest = tabs.filter((t) => t.id !== command.params.id);
      // Closing the tab on screen hands the stage to whatever is left, so the
      // page is never showing nothing while holding something.
      const activeId = state.activeId === command.params.id ? (rest[rest.length - 1]?.id ?? null) : state.activeId;
      return { state: { tabs: rest, activeId }, result: { id: command.params.id, activeId } };
    }
  }
}
