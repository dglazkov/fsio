// The mock application, as a pure function.
//
// It lives in src/ rather than web/ because both sides need it: the page
// applies operations for real, and the tests apply them without a browser.
// Nothing in here knows about the folder, the session, or the CLI — the
// whole point of the actuator pattern is that the thing being actuated is
// an ordinary application that happens to accept commands from elsewhere.

/** One tab of the mock app. Title and message is the entire domain — the
 *  demo is about the channel, not about the app on the end of it. */
export interface Tab {
  id: string;
  title: string;
  message: string;
}

export interface AppState {
  tabs: Tab[];
  activeId: string | null;
}

/** The five verbs, as they arrive on the wire. The CLI parses argv into one
 *  of these; the page switches on `method`. */
export type Operation =
  | { method: "tabs.add"; params: { title: string; message: string; activate?: boolean } }
  | { method: "tabs.remove"; params: { id: string } }
  | { method: "tabs.activate"; params: { id: string } }
  | { method: "tabs.update"; params: { id: string; title?: string; message?: string } }
  | { method: "tabs.list"; params: Record<string, never> };

export const METHODS: Operation["method"][] = [
  "tabs.add",
  "tabs.remove",
  "tabs.activate",
  "tabs.update",
  "tabs.list",
];

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

/** What a fresh page shows: one tab that explains what it is. A page with
 *  nothing in it cannot tell you it is waiting for a CLI (P6 — the page is
 *  a working app before anything actuates it). */
export function initialState(): AppState {
  return {
    tabs: [
      {
        id: "welcome",
        title: "Welcome",
        message:
          "This page owns its own state. Nothing here came from a server — it came from a terminal on this machine, through the folder you granted.\n\nTry: actuator tabs add --title Build --message \"CI is running\"",
      },
    ],
    activeId: "welcome",
  };
}

/** Apply one operation. Pure: takes a state, returns the next state and
 *  whatever the CLI should be told. Throws AppError when the app says no.
 *
 *  `makeId` is a parameter so tests get stable ids without stubbing crypto. */
export function apply(
  state: AppState,
  op: Operation,
  makeId: () => string = newTabId
): { state: AppState; result: Record<string, unknown> } {
  const tabs = state.tabs.map((t) => ({ ...t }));
  const find = (id: string): Tab => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) {
      throw new AppError("tab_not_found", `no tab with id ${JSON.stringify(id)}`, "run `actuator tabs list` to see the ids this page holds");
    }
    return tab;
  };

  switch (op.method) {
    case "tabs.add": {
      const tab: Tab = { id: makeId(), title: op.params.title, message: op.params.message };
      const activate = op.params.activate !== false;
      tabs.push(tab);
      return {
        state: { tabs, activeId: activate ? tab.id : state.activeId },
        result: { id: tab.id, title: tab.title, active: activate },
      };
    }
    case "tabs.remove": {
      find(op.params.id);
      const rest = tabs.filter((t) => t.id !== op.params.id);
      // Removing the active tab hands focus to whatever is left, so the
      // page is never showing nothing while holding something.
      const activeId = state.activeId === op.params.id ? (rest[0]?.id ?? null) : state.activeId;
      return { state: { tabs: rest, activeId }, result: { id: op.params.id, activeId } };
    }
    case "tabs.activate": {
      const tab = find(op.params.id);
      return { state: { tabs, activeId: tab.id }, result: { id: tab.id, title: tab.title } };
    }
    case "tabs.update": {
      const tab = find(op.params.id);
      if (op.params.title !== undefined) tab.title = op.params.title;
      if (op.params.message !== undefined) tab.message = op.params.message;
      return { state: { tabs, activeId: state.activeId }, result: { id: tab.id, title: tab.title } };
    }
    case "tabs.list":
      return { state: { tabs, activeId: state.activeId }, result: { tabs, activeId: state.activeId } };
  }
}
