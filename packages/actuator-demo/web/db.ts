import { applyOperation, initialState, type Command, type CommandResult, type TabState, AppError } from "../src/model";

const DB = "fsio-actuator-demo";
const STORE = "app";
const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function loadState(): Promise<TabState> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get("state");
    request.onsuccess = () => resolve((request.result as TabState | undefined) ?? initialState());
    request.onerror = () => reject(request.error);
  });
}

/** State mutation and command deduplication share one IDB transaction: a
 * reload after application but before the folder receipt cannot apply twice. */
export async function applyCommand(command: Command): Promise<CommandResult> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const prior = store.get(`command:${command.id}`);
    prior.onerror = () => reject(prior.error);
    prior.onsuccess = () => {
      if (prior.result) { resolve(prior.result as CommandResult); return; }
      const stateRequest = store.get("state");
      stateRequest.onerror = () => reject(stateRequest.error);
      stateRequest.onsuccess = () => {
        let result: CommandResult;
        try {
          const applied = applyOperation((stateRequest.result as TabState | undefined) ?? initialState(), command);
          store.put(applied.state, "state");
          result = { commandId: command.id, status: "applied", completedAt: new Date().toISOString(), result: applied.result };
        } catch (error) {
          const e = error instanceof AppError ? error : new AppError("internal_error", error instanceof Error ? error.message : String(error));
          result = { commandId: command.id, status: "failed", completedAt: new Date().toISOString(), error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } };
        }
        store.put(result, `command:${command.id}`);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      };
    };
  });
}

export async function setState(state: TabState): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(state, "state");
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
}
