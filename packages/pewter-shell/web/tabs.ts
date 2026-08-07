// The tabs this page holds — the operations the page answers itself.
//
// Everything the shell served before these was a question about the machine,
// forwarded to the host and answered there. A tab is not on disk anywhere, and
// a flung copy is in this browser's storage, so there is nothing to forward:
// the page is the answer. Three callers land in `answer()` below and none of
// them can tell the others apart —
//
//   the shell     opening its first extension, at startup.
//   an extension  calling `pewt.tabs.add()` or `pewt.fling()` through the
//                 bridge.
//   a terminal    typing `pewt open notes.md`, which the host forwards down
//                 this page's own session (session.ts).
//
// The state and its rules are `pewter`'s `applyTabs`, a pure function shared
// with the host and the tests. What is here is everything a browser adds to
// it: building the extension before a tab exists to show it, reading a file
// through the grant before a copy exists to show, and the frames.
//
// **Why the frames are not rendered by Lit.** Moving an iframe in the DOM
// reloads it, and a list Lit re-renders moves its nodes when the list changes.
// A tab whose terminal cleared itself because a *different* tab closed would
// be a bug nobody could explain from the code that appears to cause it. So the
// stage is a plain container this module owns: one pane per tab, appended
// once, hidden rather than removed, and dropped only when its tab closes. File
// tabs get a pane the same way — they are not iframes and would survive being
// moved, but a stage with two rules about who owns it is worse than one.
import { applyTabs, asTabCommand, bodyLabel, TabError, type Tab, type TabCommand } from "pewter";
import { mount } from "./bridge";
import { keepBlob, dropBlob, loadCatalog, saveCatalog, sweepBlobs } from "./db";
import { buildExtension } from "./extension";
import { forget, keyFor, reloadFileViews } from "./files";
import { log, reporter } from "./reporter";
import { fileAt } from "./session";
import { extError, opened, pewterName, tabs } from "./state";

/** The pane each tab's frame or viewer lives in, by tab id. */
const panes = new Map<string, HTMLElement>();
let stage: HTMLElement | null = null;

/** Hand this module the rectangle the tabs go in. Called once, by the shell
 *  component, as soon as the page is live. */
export function setStage(el: HTMLElement): void {
  if (stage === el) return;
  stage = el;
  for (const [, pane] of panes) el.append(pane);
  showActive();
}

/** The copies this page already holds for this pewter.
 *
 *  Called once, when the session says which pewter this is. Until then the
 *  catalog is empty — not because nothing was kept, but because the page does
 *  not yet know whose it would be (db.ts). Nothing can ask about it before
 *  this runs: a command needs a session, and this happens while one opens. */
export async function adoptCatalog(name: string): Promise<void> {
  pewterName.set(name);
  const held = await loadCatalog(name);
  tabs.set({ ...tabs.get(), held });
  reporter.event("catalog", { pewter: name, files: held.length });
  if (held.length) log(`${held.length} file${held.length === 1 ? "" : "s"} this page already holds`);
  // Bytes the catalog does not name, from a fling whose page died between the
  // store and the commit. Harmless, and swept where it cannot race a command.
  void sweepBlobs(name, held);
  // A window loaded before the grant was back read nothing and cached "gone".
  reloadFileViews();
}

/** One command, checked and applied. Whoever asked, this is the answer.
 *
 *  The check runs here even when the host already ran it (packages/pewt/src/
 *  ops.ts): anything that can write the folder can write anything
 *  (spec/PROTOCOL.md, threat model), so a command arriving down the session is
 *  not vouched for by having arrived. */
export async function answer(method: string, params: unknown): Promise<Record<string, unknown>> {
  const command = asTabCommand(method, params);
  if (!command) throw new TabError("bad_params", `${method} did not get the parameters it needs`);

  // Three commands have work to do before there is a tab, and all three do it
  // for the same reason: a tab committed before the thing it shows exists
  // would be a strip entry pointing at nothing. So a build that fails, a path
  // that is not there, and a browser that will not store a copy each refuse
  // the command — the reason goes back to whoever asked.
  const prepared = await prepare(command);

  const { state, result } = applyTabs(tabs.get(), command, prepared.flung ? { flung: prepared.flung, makeFileId: () => prepared.fileId! } : {});

  // A pane, for a tab that did not already have one. Three commands can come
  // back with a tab that was already open — `open` and `files show` reuse one
  // by design, and a fling that supersedes moves its reference under the tab
  // showing the old copy — and mounting a second pane on any of them would
  // stack two viewers in one box.
  const id = typeof result["id"] === "string" ? result["id"] : null;
  if (prepared.mount && id && !panes.has(id)) {
    const box = pane(id, prepared.mount);
    panes.set(id, box);
    stage?.append(box);
    if (prepared.bundle) {
      const b = prepared.bundle;
      opened.set({ ...opened.get(), [id]: { name: b.name, hash: b.hash, bytes: b.bytes, rebuilt: b.rebuilt } });
      log(`${b.name} → ${id} (${b.bytes} B, ${b.hash})${b.rebuilt ? ` rebuilt in ${b.ms} ms` : ""}`);
    }
  }

  if (command.method === "tabs.close") drop(command.params.id);
  if (command.method === "files.drop") {
    // The tabs the rules closed, and then the bytes. In that order: a pane
    // reading a blob that had already gone would render "missing" for the
    // instant before it was removed.
    for (const tab of tabs.get().tabs) {
      if (tab.body.kind === "held" && tab.body.fileId === command.params.id) drop(tab.id);
    }
    forget(`held:${command.params.id}`);
    void dropBlob(pewterName.get(), command.params.id);
  }
  if (command.method === "files.fling") {
    // A second fling of the same path replaced the first, and its bytes are
    // nobody's now. A tab that was showing the old copy follows the new one
    // over, so the pane stays and only the reference under it moved.
    const superseded = result["superseded"];
    if (typeof superseded === "string") {
      forget(`held:${superseded}`);
      void dropBlob(pewterName.get(), superseded);
    }
  }

  tabs.set(state);
  // The catalog is the page's own and outlives the tabs, so it is written back
  // whenever it moved. The two commands that move it are the two that took or
  // released custody of bytes.
  if (command.method === "files.fling" || command.method === "files.drop") void saveCatalog(pewterName.get(), state.held);
  showActive();
  reporter.event(`tab-${command.method.replace(".", "-")}`, { ...result });
  return result;
}

/** What a command needs in hand before the rules run. */
interface Prepared {
  bundle?: Awaited<ReturnType<typeof buildExtension>>;
  /** the element the new tab's pane holds, when the command makes one. */
  mount?: HTMLElement;
  flung?: { type: string; size: number };
  fileId?: string;
}

async function prepare(command: TabCommand): Promise<Prepared> {
  if (command.method === "tabs.add") {
    const bundle = await buildExtension(command.params.name);
    // `args` goes to the frame and nowhere else — not into the tab's state,
    // which is what the strip shows, not how a tab was launched.
    return { bundle, mount: mount(bundle.html, command.params.name, command.params.args) };
  }

  if (command.method === "files.open") {
    // A path with nothing at it is refused rather than opened. A window whose
    // file is deleted later is a normal state and says so on screen; a window
    // opened onto a typo would say the same thing and mean something else.
    const file = await fileAt(command.params.path);
    if (!file) {
      throw new TabError(
        "file_not_found",
        `no file at ${JSON.stringify(command.params.path)} in this pewter`,
        "paths are relative to the pewter, not to where you are standing — `pewt repos` lists the projects under repos/"
      );
    }
    return { mount: viewer() };
  }

  if (command.method === "files.fling") {
    const file = await fileAt(command.params.path);
    if (!file) {
      throw new TabError(
        "file_not_found",
        `no file at ${JSON.stringify(command.params.path)} in this pewter`,
        "the page reads it through the folder you granted, so a path outside the pewter is not one it can copy"
      );
    }
    // The bytes go into storage before the catalog is committed, so the two
    // can only disagree in the harmless direction: bytes with no entry (swept
    // on the next load), never an entry with no bytes. Out of quota is the
    // realistic failure and it is the page's own answer to give.
    const fileId = `file-${Math.random().toString(16).slice(2, 10)}`;
    try {
      await keepBlob(pewterName.get(), fileId, file);
    } catch (e) {
      throw new TabError(
        "store_failed",
        `this browser would not store ${command.params.path}: ${e instanceof Error ? e.message : String(e)}`,
        "the page holds flung copies in its own storage — `pewt files drop <id>` frees some"
      );
    }
    return { flung: { type: file.type, size: file.size }, fileId, mount: viewer() };
  }

  if (command.method === "files.show") {
    // No pane when a tab is already on it: `files.show` reuses one, and the
    // rules are what decide. Asking them first would mean applying the command
    // twice, so this asks the same question the cheap way.
    const shown = tabs.get().tabs.find((t) => t.body.kind === "held" && t.body.fileId === command.params.id);
    return shown ? {} : { mount: viewer() };
  }

  return {};
}

/** A file tab's pane holds one of these. It looks its own tab up by id, so a
 *  fling that supersedes a copy moves the reference under it without the
 *  element being replaced — and without the pane being touched, which is what
 *  the stage is imperative to protect. */
function viewer(): HTMLElement {
  return document.createElement("pewter-file-view");
}

function pane(id: string, child: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = "pane";
  el.dataset["tab"] = id;
  if (child.tagName === "PEWTER-FILE-VIEW") (child as HTMLElement & { tabId: string }).tabId = id;
  el.append(child);
  return el;
}

/** Take a tab's pane out of the document, and its bytes out of memory.
 *
 *  Whatever the frame was running — a shell, an agent — ends the way it would
 *  if you closed the page: the session it held is dropped, and the host reaps
 *  what it started (D6). A window's cached bytes go too; a held copy's do not,
 *  because the copy is still the page's and `pewt files show` brings it back. */
function drop(id: string): void {
  const tab = tabs.get().tabs.find((t) => t.id === id);
  panes.get(id)?.remove();
  panes.delete(id);
  const rest = { ...opened.get() };
  delete rest[id];
  opened.set(rest);
  if (tab?.body.kind === "file") forget(keyFor(tab.body)!);
}

/** Open an extension, as the shell itself does at startup.
 *
 *  The same command a terminal sends, taken from the inside — there is no
 *  privileged path to a first screen, which is the claim `extensions/repos/`
 *  exists to prove. A failure here is shown on the page rather than thrown:
 *  nobody typed this, so there is nobody to refuse. */
export async function openFirst(name: string): Promise<boolean> {
  extError.set("");
  try {
    await answer("tabs.add", { name });
    return true;
  } catch (e) {
    const err = e as { message?: string; hint?: string; code?: string };
    // A compile error is the common case and it is the extension author's to
    // fix, so it is shown as it came — esbuild's own words, including which
    // line — rather than summarized into "could not open".
    extError.set(`${err.message ?? String(e)}${err.hint ? `\n${err.hint}` : ""}`);
    reporter.event("ext-failed", { name, code: err.code ?? "internal" });
    log(`${name} → ${err.code ?? "failed"}: ${err.message ?? String(e)}`);
    return false;
  }
}

/** Bring the active tab's pane forward. Hidden rather than removed: a tab you
 *  are not looking at is still running. */
function showActive(): void {
  const { activeId } = tabs.get();
  for (const [id, pane] of panes) pane.toggleAttribute("hidden", id !== activeId);
}

/** What the strip's chips are made of. Here rather than in the component
 *  because it is a reading of the state, and the component's job is layout. */
export const chipsOf = (list: Tab[]): { id: string; name: string; secondary?: string }[] =>
  list.map((t) => {
    const what = bodyLabel(t.body);
    return { id: t.id, name: t.title, ...(t.title === what ? {} : { secondary: what }) };
  });
