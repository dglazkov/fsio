// Opening an extension: ask the host for it, read the bytes, mount the frame.
//
// The two halves travel differently and deliberately so. The *request* rides
// the session — it is a question, and the host is the only thing that can
// answer it, because only the host can compile. The *bytes* ride the folder
// as a file: the host writes one self-contained HTML file under `.pewter/`
// and says where, and the page opens it through the grant it already holds.
//
// Both obey P2 — nothing here leaves the folder. What the split buys is that
// opening a tab costs no frames, and re-opening one costs no build: the host
// rebuilds only when a source file is newer than the bundle, so the answer
// to "open this again" is usually a path and a hash.
import { mount } from "./bridge";
import { callHost, readAt, ShellCallError } from "./session";
import { extError, open } from "./state";
import { log, reporter, step } from "./reporter";

export interface Bundle {
  name: string;
  path: string;
  bytes: number;
  hash: string;
  rebuilt: boolean;
  ms?: number;
}

/** Open one extension into the given container, replacing whatever was in
 *  it. Returns false when the extension could not be opened, having already
 *  said why on screen. */
export async function openExtension(name: string, into: HTMLElement): Promise<boolean> {
  extError.set("");
  step(`opening ${name}`);

  let bundle: Bundle;
  try {
    bundle = (await callHost("ext.bundle", { name })) as Bundle;
  } catch (e) {
    const err = e instanceof ShellCallError ? e : null;
    // A compile error is the common case here and it is the extension
    // author's to fix, so it is shown as it came — esbuild's own words,
    // including which line — rather than summarized into "could not open".
    extError.set(err ? `${err.message}${err.hint ? `\n${err.hint}` : ""}` : String(e));
    reporter.event("ext-failed", { name, code: err?.code ?? "internal" });
    log(`${name} → ${err?.code ?? "failed"}: ${err?.message ?? String(e)}`);
    return false;
  }

  const html = await readAt(bundle.path);
  if (html === null) {
    // The host said it wrote a file and the page cannot read it. That is not
    // a compile error and not a refusal: something disagrees about the
    // folder, and saying which file is missing is the only useful thing to
    // say about it.
    extError.set(`The host built ${name} but this page cannot read ${bundle.path} in the folder you granted.`);
    reporter.event("ext-unreadable", { name, path: bundle.path });
    return false;
  }

  into.replaceChildren(mount(html, name));
  open.set({ name, hash: bundle.hash, bytes: bundle.bytes, rebuilt: bundle.rebuilt });
  reporter.event("ext-open", { name, hash: bundle.hash, bytes: bundle.bytes, rebuilt: bundle.rebuilt });
  log(`${name} → ${bundle.path} (${bundle.bytes} B, ${bundle.hash})${bundle.rebuilt ? ` rebuilt in ${bundle.ms} ms` : ""}`);
  return true;
}
