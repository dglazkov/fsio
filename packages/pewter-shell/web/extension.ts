// Getting an extension: ask the host for it, read the bytes.
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
//
// Where those bytes then go is tabs.ts's business. This stops at "here is the
// document", so that the thing which fails — a compile error, a bundle the
// page cannot read — fails before any tab exists to show it.
import { callHost, readAt, ShellCallError } from "./session";
import { step } from "./reporter";

export interface Bundle {
  name: string;
  path: string;
  bytes: number;
  hash: string;
  rebuilt: boolean;
  ms?: number;
}

/** A built extension, and the document to put in a frame.
 *
 *  Throws ShellCallError. A compile error carries esbuild's own words — it is
 *  the extension author's to fix, and summarizing it into "could not open"
 *  would throw away the line number — and a bundle the page cannot read
 *  carries the path, because those are two different things to go and fix. */
export async function buildExtension(name: string): Promise<Bundle & { html: string }> {
  step(`opening ${name}`);
  const bundle = (await callHost("ext.bundle", { name })) as Bundle;
  const html = await readAt(bundle.path);
  if (html === null) {
    // The host said it wrote a file and the page cannot read it. That is not
    // a compile error and not a refusal: something disagrees about the
    // folder, and saying which file is missing is the only useful thing to
    // say about it.
    throw new ShellCallError(
      "unreadable",
      `The host built ${name} but this page cannot read ${bundle.path} in the folder you granted.`
    );
  }
  return { ...bundle, html };
}
