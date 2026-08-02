// Opening the page (#124), and deciding whether to.
//
// The helper knows the URL; the human should not have to carry it between
// two surfaces. But auto-navigation is a small surprise — they ran `npx`,
// they did not ask to be sent to a remote address — so the URL is *printed*
// first, always, and every path through this file ends with a line saying
// what happened.
//
// Two things here are less obvious than they look.
//
// **Which browser.** Opening the *default* browser is a downgrade when that
// browser is Safari or Firefox: the page needs File System Access, so the
// human would be sent automatically to a page that cannot work — strictly
// worse than a URL they had to paste, because now the failure looks like
// ours. So a Chromium is resolved explicitly, and when none is found nothing
// is opened and the reason is printed.
//
// **Whether to open at all.** A helper Ctrl-C'd and restarted five times
// must not leave five tabs. The signal is already in the folder and costs
// nothing to read: `fresh: true` sweeps `.fsio/client/` at startup, and a
// live page's reporter re-attaches and writes there within a beat of seeing
// the helper come back (connection.ts). So a directory reappearing under
// `client/` after the sweep means a page is open, granted, and watching —
// and a tab would be litter. Nothing appearing means nobody is watching, or
// nobody ever has.
//
// The wait only happens when the folder shows evidence of prior use, which
// keeps it off the path it would hurt most: a genuine first run in a fresh
// folder has no client dirs to have swept, so it opens immediately.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

/** Chromium browsers by bundle id, best first. Chrome is the one the demo is
 *  written against; the rest are the same engine and the same File System
 *  Access implementation. Firefox and Safari are deliberately absent — this
 *  list is "browsers where the page works", not "browsers". */
export const CHROMIUMS: { id: string; name: string }[] = [
  { id: "com.google.Chrome", name: "Google Chrome" },
  { id: "com.microsoft.edgemac", name: "Microsoft Edge" },
  { id: "com.brave.Browser", name: "Brave" },
  { id: "org.chromium.Chromium", name: "Chromium" },
];

export type OpenOutcome = { opened: true; browser: string } | { opened: false; why: string };

/** Hand the URL to the first Chromium that will take it.
 *
 *  `open -b <id>` fails cleanly when that browser is not installed, so the
 *  probe and the open are one act: the first success IS the tab. No polling
 *  /Applications, no guessing at install locations, no window stolen from a
 *  browser that turned out not to be there. */
export async function openInChromium(url: string, platform: string = process.platform): Promise<OpenOutcome> {
  if (platform !== "darwin") {
    return { opened: false, why: `opening a browser is only wired up on macOS (this is ${platform})` };
  }
  for (const b of CHROMIUMS) {
    const ok = await new Promise<boolean>((resolve) => {
      execFile("open", ["-b", b.id, url], { timeout: 10000 }, (err) => resolve(!err));
    });
    if (ok) return { opened: true, browser: b.name };
  }
  return { opened: false, why: `no Chromium browser found (looked for ${CHROMIUMS.map((b) => b.name).join(", ")})` };
}

/** Has any page ever reported into this folder? Read BEFORE the host's
 *  `fresh` sweep, because the sweep is what makes the answer afterwards
 *  meaningful — see `pageIsWatching`. */
export function hasClientDirs(fsioDir: string): boolean {
  try {
    return fs.readdirSync(path.join(fsioDir, "client"), { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    return false; // no .fsio at all, or no page has ever attached: a first run
  }
}

/** Wait for a live page to say so, up to `ms`.
 *
 *  Resolves true as soon as a client dir exists again — the sweep removed
 *  them all, so anything here now was written after this helper started, by a
 *  page that can still see the folder. Resolves false on timeout, which is
 *  the ordinary answer and the one that opens a tab.
 *
 *  The window has to cover the page's own 2 s helper poll plus its reporter
 *  flush; 3.5 s leaves margin without turning a restart into a wait anybody
 *  would sit through. */
export async function pageIsWatching(fsioDir: string, ms = 3500, stepMs = 250): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (hasClientDirs(fsioDir)) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
