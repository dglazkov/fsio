// One way in, for every operation.
//
// A command from the terminal and a click in the page arrive here as the
// same value and take the same path: check what only the page can check,
// apply, keep the byte cache honest, say what happened. The demo's standing
// claim is that the app cannot tell the two apart, and this is the file
// that has to be true for it — the only difference either origin makes is
// one word in the status line.
import { AppError, basename, mimeFor, safeRelPath, type AppState, type Operation } from "../src/model";
import { toBase64 } from "../src/bytes";
import { applyToApp } from "./db";
import { forget, keyFor, load } from "./content";
import { fileAt, readFileAt, watching } from "./folder";
import { app, lastCommand } from "./state";
import { reporter } from "./reporter";

export async function runOperation(op: Operation, origin: "cli" | "page"): Promise<Record<string, unknown>> {
  try {
    if (op.method === "files.open") await mustExist(op.params.path);
    const before = app.get();
    const result = await applyToApp(op);
    afterEffects(op, result, before);
    lastCommand.set({ method: op.method, ok: true, detail: describe(op, result), origin });
    if (origin === "page") reporter.event("applied", { method: op.method, origin, ok: true });
    return result;
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError("internal", e instanceof Error ? e.message : String(e));
    lastCommand.set({ method: op.method, ok: false, detail: err.message, origin });
    if (origin === "page") reporter.event("applied", { method: op.method, origin, ok: false, error: err.code });
    throw err;
  }
}

/** The one check the reducer cannot make: whether the page can actually see
 *  that file. A tab pointing at nothing is worse than a refusal, and the
 *  two ways to get one — no folder, or no such file — need different
 *  sentences, because they need different fixes. */
async function mustExist(path: string): Promise<void> {
  if (!watching()) {
    throw new AppError(
      "no_folder",
      "this page has no folder granted, so it cannot look at anything",
      "grant it the folder in the page, or use `actuator fling` to hand it a copy it can keep"
    );
  }
  const safe = safeRelPath(path);
  if (!safe) return; // not a path at all — the reducer's `bad_path` says it better
  if (!(await fileAt(safe))) {
    throw new AppError(
      "file_not_found",
      `no file at ${JSON.stringify(path)} in the granted folder`,
      "paths are relative to the folder you granted the page"
    );
  }
}

/** Keep the byte cache in step with the catalog: load what a new tab is
 *  showing, and let go of what nothing shows any more. */
function afterEffects(op: Operation, result: Record<string, unknown>, before: AppState): void {
  switch (op.method) {
    case "files.drop":
      forget(`held:${op.params.id}`);
      break;
    case "files.fling": {
      const superseded = result["superseded"];
      if (typeof superseded === "string") forget(`held:${superseded}`);
      void load({ kind: "held", fileId: String(result["fileId"]) });
      break;
    }
    case "files.open":
      if (typeof result["path"] === "string") void load({ kind: "local", path: result["path"] });
      break;
    case "files.show": {
      const tab = app.get().tabs.find((t) => t.id === result["id"]);
      if (tab) void load(tab.body);
      break;
    }
    case "tabs.remove": {
      // The closed tab may have been the last window onto those bytes, and
      // an image's object URL is held by the document until it is revoked.
      const closed = before.tabs.find((t) => t.id === op.params.id);
      const key = closed && keyFor(closed.body);
      if (key && !app.get().tabs.some((t) => keyFor(t.body) === key)) forget(key);
      break;
    }
    default:
      break;
  }
}

/** A page-side fling: the same operation the CLI sends, built from a file
 *  the page can already read.
 *
 *  The bytes make a round trip through base64 they did not have to make —
 *  the page has the blob in hand. It is a few milliseconds on a file this
 *  demo will carry, and it buys the thing worth having: there is exactly
 *  one fling, and it is the one on the wire. A second, shorter path for
 *  page-side flings would be a second set of rules about what a held file
 *  is. */
export async function flingLocal(path: string, folderName: string): Promise<Record<string, unknown>> {
  const file = await readFileAt(path);
  if (!file) throw new AppError("file_not_found", `no file at ${JSON.stringify(path)} in the granted folder`);
  const name = basename(path);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return runOperation(
    {
      method: "files.fling",
      params: {
        name,
        // Provenance as the page knows it. The CLI writes an absolute path
        // here; the page only ever knows a folder name and a path under it,
        // and saying so is better than inventing a root it cannot see.
        from: `${folderName}/${path}`,
        type: file.type || mimeFor(name),
        size: bytes.byteLength,
        data: toBase64(bytes),
      },
    },
    "page"
  );
}

const describe = (op: Operation, result: Record<string, unknown>): string => {
  switch (op.method) {
    case "tabs.list":
      return `${app.get().tabs.length} tab(s)`;
    case "files.list":
      return `${app.get().held.length} file(s) held`;
    case "files.open":
      return `${String(result["path"])} — read from the folder`;
    case "files.fling":
      return `${String(result["name"])} — ${String(result["size"])} bytes, now held here`;
    case "files.drop":
      return `${String(result["name"])} — let go`;
    default:
      return String(result["id"] ?? "ok");
  }
};
