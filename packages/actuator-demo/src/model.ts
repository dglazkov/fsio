export interface Tab { id: string; title: string; message: string }
export interface TabState { tabs: Tab[]; activeId: string | null }

export type ActuatorOperation =
  | { method: "tabs.add"; params: { title: string; message: string; activate?: boolean } }
  | { method: "tabs.remove"; params: { id: string } }
  | { method: "tabs.activate"; params: { id: string } }
  | { method: "tabs.update"; params: { id: string; title?: string; message?: string } }
  | { method: "tabs.list"; params: Record<string, never> };

export type Command = ActuatorOperation & {
  id: string;
  createdAt: string;
  expiresAt?: string;
};

export interface CommandResult {
  commandId: string;
  status: "applied" | "failed";
  completedAt: string;
  result?: unknown;
  error?: { code: string; message: string; hint?: string };
}

export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) { super(message); }
}

export function initialState(): TabState {
  return { tabs: [{ id: "welcome", title: "Welcome", message: "This state belongs to the page. Use the actuator CLI to change it." }], activeId: "welcome" };
}

export function applyOperation(state: TabState, op: ActuatorOperation, makeId = () => `tab-${crypto.randomUUID().slice(0, 8)}`): { state: TabState; result: unknown } {
  const tabs = state.tabs.map((tab) => ({ ...tab }));
  const find = (id: string): Tab => {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) throw new AppError("tab_not_found", `Tab ${JSON.stringify(id)} does not exist.`, "Run `actuator tabs list --wait` to discover tab IDs.");
    return tab;
  };
  switch (op.method) {
    case "tabs.add": {
      const tab = { id: makeId(), title: op.params.title, message: op.params.message };
      tabs.push(tab);
      return { state: { tabs, activeId: op.params.activate === false ? state.activeId : tab.id }, result: { tabId: tab.id, active: op.params.activate !== false } };
    }
    case "tabs.remove": {
      find(op.params.id);
      const next = tabs.filter((tab) => tab.id !== op.params.id);
      const activeId = state.activeId === op.params.id ? (next[0]?.id ?? null) : state.activeId;
      return { state: { tabs: next, activeId }, result: { tabId: op.params.id, activeId } };
    }
    case "tabs.activate":
      find(op.params.id);
      return { state: { tabs, activeId: op.params.id }, result: { tabId: op.params.id } };
    case "tabs.update": {
      const tab = find(op.params.id);
      if (op.params.title !== undefined) tab.title = op.params.title;
      if (op.params.message !== undefined) tab.message = op.params.message;
      return { state: { tabs, activeId: state.activeId }, result: { tabId: tab.id } };
    }
    case "tabs.list":
      return { state: { tabs, activeId: state.activeId }, result: { tabs, activeId: state.activeId } };
  }
}
