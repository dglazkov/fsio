// Opening the shell, and deciding whether to.
//
// Adapted from acp-demo/src/open.ts, which has the long version of both
// notes; the short version:
//
// **Which browser.** Not the default one. The shell needs the File System
// Access API, so sending someone to it in Safari or Firefox is worse than
// printing a URL they have to paste — the failure would look like ours. A
// Chromium is resolved explicitly, and when none is found nothing opens and
// the reason is printed.
//
// **Whether to open at all.** A host restarted five times should not leave
// five tabs. `fresh: true` sweeps `.fsio/client/` at startup, so a client
// directory that reappears afterwards is a live page saying so. This is
// best-effort: a tab hidden more than five minutes is clamped to about one
// timer a minute (F16) and cannot answer inside any window worth waiting
// through, so it gets a second tab
// ([#144](https://github.com/dglazkov/fsio/issues/144)).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Chromium browsers by bundle id, best first. Firefox and Safari are
 *  deliberately absent: this list is "browsers where the shell works". */
export const CHROMIUMS: { id: string; name: string }[] = [
  { id: "com.google.Chrome", name: "Google Chrome" },
  { id: "com.microsoft.edgemac", name: "Microsoft Edge" },
  { id: "com.brave.Browser", name: "Brave" },
  { id: "org.chromium.Chromium", name: "Chromium" },
];

export type OpenOutcome = { opened: true; browser: string } | { opened: false; why: string };

/** Hand the URL to the first Chromium that will take it. `open -b <id>`
 *  fails cleanly when that browser is not installed, so the probe and the
 *  open are one act: the first success is the tab. */
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

/** Has any page ever reported into this folder? Read BEFORE the `fresh`
 *  sweep, because the sweep is what makes the answer afterwards mean
 *  something. */
export function hasClientDirs(fsioDir: string): boolean {
  try {
    return fs.readdirSync(path.join(fsioDir, "client"), { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

/** Wait for a live page to say so. False is "nobody answered in time",
 *  which is not the same claim as "no page is open". */
export async function pageIsWatching(fsioDir: string, ms = 3500, stepMs = 250): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (hasClientDirs(fsioDir)) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
