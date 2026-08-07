// The Pewter shell: the page at pewter.town.
//
// It holds the tab and provides the `pewt` API. Everything you look at is an
// extension out of the folder you granted — including the first screen, which
// is `extensions/repos/` and is exactly as replaceable as one you write.
//
// Self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json}
// for the cooperative verification loop (TESTING.md).
import "@fsio/ui/boot"; // must stay first — see that module
import "@fsio/ui"; // registers the shared chrome's custom elements
import "./components/app-shell";
import "./components/file-view"; // the one screen the shell draws itself
import { step } from "./reporter";
import { acceptDrop, checkGates, closeOnPagehide, revisit } from "./session";

checkGates();
step("waiting for a folder");
document.body.dataset["fsioState"] = "setup";

// A reload does not start from zero: the folder this page held last time is
// offered back, or reconnected outright if its grant survived (#185). The
// host that opened this page may name the folder it serves (`?dir=`, from
// `pewt serve`), and that hint outranks the memory.
void revisit(new URLSearchParams(location.search).get("dir"));

// Drag a pewter onto the page — a picker-free path for a human, and the only
// path a script can take at all: a drop can be synthesized (F14) and the
// picker cannot be. Both listeners are needed, on the body rather than the
// window: without preventDefault on dragover the browser navigates to the
// dropped folder instead of handing it over.
document.body.addEventListener("dragover", (e) => e.preventDefault());
document.body.addEventListener("drop", (e) => {
  e.preventDefault();
  const item = e.dataTransfer?.items[0];
  if (!item?.getAsFileSystemHandle) return;
  // Called here, synchronously: the item is dead once this handler returns.
  void acceptDrop(item.getAsFileSystemHandle());
});

window.addEventListener("pagehide", closeOnPagehide);
// bfcache would revive a page whose session was just closed — reload so the
// folder is picked fresh.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});
