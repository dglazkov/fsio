// A shell on this machine, in a tab.
//
// What `pewt.shell()` hands over is live and raw: the pty's own bytes,
// escape sequences included, with keystrokes and window sizes going back the
// other way. The host holds no opinion about what draws them — the emulator
// here is xterm, an ordinary dependency of this pewter, and swapping it for
// another touches nothing outside this directory.
//
// One tab is one shell. For a second one, open another tab:
// `pewt tabs add terminal`.
import { pewt, args, explain } from "pewter";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
// The shared look: tokens and base styles, an ordinary dependency of this
// pewter — the same arrangement as the emulator above.
import "pewter-ui/style.css";

const status = document.getElementById("status")!;
const said = document.getElementById("said")!;
const again = document.getElementById("again") as HTMLButtonElement;
const picker = document.getElementById("picker")!;
const note = document.getElementById("note")!;
const places = document.getElementById("places")!;
const host = document.getElementById("term")!;

/** xterm takes concrete colours, not custom properties, so the palette is
 *  spelled out — and it is yours: this file is in your pewter. The sixteen
 *  ANSI colours are muted rather than the VGA defaults, which arrive as
 *  saturated primaries the moment anything colours its output. */
const THEME = {
  background: "#17191c",
  foreground: "#d6dbdf",
  cursor: "#d6dbdf",
  cursorAccent: "#17191c",
  selectionBackground: "#3f6f7859",

  black: "#1f2328",
  red: "#c97d79",
  green: "#93b899",
  yellow: "#dcba76",
  blue: "#8098ab",
  magenta: "#b294bb",
  cyan: "#8fbfc7",
  white: "#d6dbdf",

  brightBlack: "#5b656d",
  brightRed: "#e79a96",
  brightGreen: "#aecfb3",
  brightYellow: "#ecd49b",
  brightBlue: "#a2b6c6",
  brightMagenta: "#c9aed1",
  brightCyan: "#aed6dc",
  brightWhite: "#eceff1",
};

/** Where a shell can start: the pewter itself, or a project under `repos/`.
 *  Asked fresh every time the picker shows, so a project cloned since the
 *  last shell is on the list. */
async function offer(): Promise<void> {
  host.hidden = true;
  picker.hidden = false;
  places.replaceChildren();
  note.textContent = "asking the host…";
  try {
    const { repos } = await pewt.repos.list();
    note.textContent = "a shell is your own account on this machine — the host asks before it opens one";
    for (const where of [null, ...repos.map((r) => r.name)]) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.textContent = where ?? "this pewter";
      button.addEventListener("click", () => void open(where));
      row.append(button);
      places.append(row);
    }
  } catch (e) {
    note.textContent = explain(e);
  }
}

/** One shell, for as long as it runs. The tab is the terminal while it does,
 *  and the picker comes back when it ends, under the code it ended on. */
async function open(repo: string | null): Promise<void> {
  picker.hidden = true;
  host.hidden = false;
  again.hidden = true;
  // The emulator first and fitted first, so the pty is born at the size the
  // tab actually has rather than resized into it a moment later.
  const term = new Terminal({
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host as HTMLElement);
  fit.fit();
  say("waiting — the host asks on its own terminal before it opens a shell");
  try {
    const shell = await pewt.shell({
      ...(repo ? { repo } : {}),
      cols: term.cols,
      rows: term.rows,
      onData: (bytes) => term.write(bytes),
    });
    status.hidden = true;
    term.onData((keys) => shell.write(keys));
    // The tab's size is the pty's size. A 0×0 box is skipped — a tab that is
    // not on screen has one, and the fit addon would propose garbage for it.
    const watch = new ResizeObserver(() => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      fit.fit();
      shell.resize(term.cols, term.rows);
    });
    watch.observe(host);
    term.focus();
    const code = await shell.exit;
    watch.disconnect();
    // What the shell printed before it ended is often the reason it ended,
    // so the terminal stays on screen — dead but readable — until you ask
    // for the next one.
    say(code === null ? "the shell ended without an exit code — a signal, or the host went away" : `the shell ended — exit ${code}`);
    again.hidden = false;
    again.onclick = () => {
      again.hidden = true;
      term.dispose();
      void offer();
    };
  } catch (e) {
    // A refusal is a normal ending: the human at the host's terminal said
    // no, or there is no host. It arrives in the operation's own words —
    // and a shell that never started leaves nothing on screen worth
    // keeping, so the picker comes straight back under the reason.
    say(explain(e));
    term.dispose();
    await offer();
  }
}

function say(text: string): void {
  said.textContent = text;
  status.hidden = false;
}

// Opened with `{repo}` — the repos row's shell verb (#198) — this screen
// skips its picker and goes straight there. Opened bare, it offers the
// choice. Either way the host asks before anything starts: the argument
// opened a screen, not a process.
const openedWith = (await args) as { repo?: unknown } | undefined;
if (openedWith && typeof openedWith.repo === "string") {
  await open(openedWith.repo);
} else {
  await offer();
}
