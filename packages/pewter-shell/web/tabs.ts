// The tabs this page holds — the first operations the page answers itself.
//
// Everything the shell served before this was a question about the machine,
// forwarded to the host and answered there. A tab is not on disk anywhere, so
// there is nothing to forward: the page is the answer. Three callers land in
// `answer()` below and none of them can tell the others apart —
//
//   the shell     opening its first extension, at startup.
//   an extension  calling `pewt.tabs.add()` through the bridge.
//   a terminal    typing `pewt tabs add dashboard`, which the host forwards
//                 down this page's own session (session.ts).
//
// The state and its rules are `pewter`'s `applyTabs`, a pure function shared
// with the host and the tests. What is here is everything a browser adds to
// it: building the extension before a tab exists to show it, and the frames.
//
// **Why the frames are not rendered by Lit.** Moving an iframe in the DOM
// reloads it, and a list Lit re-renders moves its nodes when the list changes.
// A tab whose terminal cleared itself because a *different* tab closed would
// be a bug nobody could explain from the code that appears to cause it. So the
// stage is a plain container this module owns: one pane per tab, appended
// once, hidden rather than removed, and dropped only when its tab closes.
import { applyTabs, asTabCommand, TabError, type Tab } from "pewter";
import { mount } from "./bridge";
import { buildExtension } from "./extension";
import { log, reporter } from "./reporter";
import { extError, opened, tabs } from "./state";

/** The pane each tab's frame lives in, by tab id. */
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

/** One command, checked and applied. Whoever asked, this is the answer.
 *
 *  The check runs here even when the host already ran it (packages/pewt/src/
 *  ops.ts): anything that can write the folder can write anything
 *  (spec/PROTOCOL.md, threat model), so a command arriving down the session is
 *  not vouched for by having arrived. */
export async function answer(method: string, params: unknown): Promise<Record<string, unknown>> {
  const command = asTabCommand(method, params);
  if (!command) throw new TabError("bad_params", `${method} did not get the parameters it needs`);

  // `tabs.add` is the one command with work to do before there is a tab: the
  // extension has to build and be read out of the folder. Doing it first means
  // a build that fails refuses the command — the compile error goes back to
  // whoever asked — instead of leaving a tab in the strip with nothing in it.
  let html: string | null = null;
  let bundle: Awaited<ReturnType<typeof buildExtension>> | null = null;
  if (command.method === "tabs.add") {
    bundle = await buildExtension(command.params.name);
    html = bundle.html;
  }

  const { state, result } = applyTabs(tabs.get(), command);
  if (command.method === "tabs.add" && html !== null && bundle) {
    const id = result["id"] as string;
    const pane = document.createElement("div");
    pane.className = "pane";
    pane.dataset["tab"] = id;
    pane.append(mount(html, command.params.name));
    panes.set(id, pane);
    stage?.append(pane);
    opened.set({ ...opened.get(), [id]: { name: bundle.name, hash: bundle.hash, bytes: bundle.bytes, rebuilt: bundle.rebuilt } });
    log(`${command.params.name} → ${id} (${bundle.bytes} B, ${bundle.hash})${bundle.rebuilt ? ` rebuilt in ${bundle.ms} ms` : ""}`);
  }
  if (command.method === "tabs.close") {
    // The frame goes with the tab. Whatever it was running — a shell, an
    // agent — ends the way it would if you closed the page: the session it
    // held is dropped, and the host reaps what it started (D6).
    panes.get(command.params.id)?.remove();
    panes.delete(command.params.id);
    const rest = { ...opened.get() };
    delete rest[command.params.id];
    opened.set(rest);
  }

  tabs.set(state);
  showActive();
  reporter.event(`tab-${command.method.slice("tabs.".length)}`, { ...result });
  return result;
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
  list.map((t) => ({ id: t.id, name: t.title, ...(t.title === t.body.name ? {} : { secondary: t.body.name }) }));
