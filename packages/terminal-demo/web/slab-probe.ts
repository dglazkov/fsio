// Dev-only probe: the real slab, without needing a folder grant.
// Constructs a Terminal with the SAME options tabs.ts uses and writes output
// that exercises all sixteen ANSI colours, so the gutter and the palette can
// be looked at. Not built (vite inputs index.html only); delete when done.
import "@fsio/ui/boot";
import "@xterm/xterm/css/xterm.css";
import "@fsio/ui";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SLAB_THEME } from "./tabs";

const term = new Terminal({
  fontSize: 13,
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  theme: SLAB_THEME,
});
const fit = new FitAddon();
term.loadAddon(fit);
const host = document.getElementById("host")!;
term.open(host);
fit.fit();

const e = "\x1b[";
term.writeln(`${e}32m~/myproject${e}0m $ ls -la`);
term.writeln(`${e}34mdrwxr-xr-x${e}0m   5 you  staff   160 Aug  3 16:07 ${e}36msrc${e}0m`);
term.writeln(`${e}34m-rw-r--r--${e}0m   1 you  staff  2339 Aug  3 16:07 package.json`);
term.writeln(`${e}32m~/myproject${e}0m $ npm test`);
term.writeln(`${e}92m✓${e}0m 41 passing ${e}90m(2.1s)${e}0m`);
term.writeln(`${e}33m⚠${e}0m 1 skipped`);
term.writeln(`${e}31merror${e}0m: the lane re-probe parked`);
term.writeln("");
term.writeln("  ANSI:");
let row = "  ";
for (let i = 0; i < 8; i++) row += `${e}3${i}m███${e}0m`;
term.writeln(row);
row = "  ";
for (let i = 0; i < 8; i++) row += `${e}9${i}m███${e}0m`;
term.writeln(row);
term.writeln("");
term.writeln(`${e}32m~/myproject${e}0m $ `);
// report the fitted geometry so the gutter's effect on cols/rows is measurable
(window as unknown as Record<string, unknown>)["probe"] = () => ({
  cols: term.cols, rows: term.rows,
  host: host.getBoundingClientRect(),
  xterm: (host.querySelector(".xterm") as HTMLElement).getBoundingClientRect(),
});

const strip = document.getElementById("strip") as HTMLElementTagNameMap["fsio-tab-strip"];
strip.chips = [
  { id: "a", name: "shell 1", secondary: "zsh", dot: "busy" },
  { id: "b", name: "shell 2", dot: "unread", badge: 2 },
];
strip.activeId = "a";
strip.menuFor = () => [
  { id: "detach", name: "Detach", note: "leave it running, stop watching", button: "Detach" },
  { id: "end", name: "End shell", note: "stops the shell for good", button: "End…", danger: true },
];
