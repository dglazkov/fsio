// A shell on this machine, in a tab.
//
// What `pewt.shell()` hands over is live and raw: the pty's own bytes,
// escape sequences included, with keystrokes and window sizes going back the
// other way. The host holds no opinion about what draws them — the emulator
// here is xterm, an ordinary dependency of this pewter, and swapping it for
// another touches nothing outside this directory.
//
// The screen itself is a lit template over two signals, drawn by `screen()`
// from `pewter-ui`: what phase this tab is in, and what the status line has
// to say. Nothing here reaches for an element to change it — the state
// changes and the screen follows.
//
// One tab is one shell. For a second one, open another tab:
// `pewt tabs add terminal`.
import { pewt, args, explain } from "pewter";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { html } from "lit";
import { signal } from "@lit-labs/signals";
// The shared look, an ordinary dependency of this pewter — the same
// arrangement as the emulator above. Importing anything from it registers
// the kit's elements, which is what makes `<pewter-status>` and
// `<pewter-menu>` below real; the css import is the styles.
import { screen } from "pewter-ui";
import "pewter-ui/style.css";

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

// ---- what this tab is, as state
//
// Four signals and no DOM handles. The rule the old shape kept breaking is
// the one this makes structural: which face is on screen is decided in one
// place, so it cannot be half-changed by an early return or a refusal on the
// way to a shell.

/** Which face this tab shows: the choice of where, or the terminal itself. */
const phase = signal<"picking" | "running">("picking");

/** The line under the heading, while the picker is up. */
const note = signal("asking the host…");

/** Where a shell can start, once the host has said. */
const places = signal<{ value: string | null; label: string }[]>([]);

/** The status line's whole state, in the shape `<pewter-status>` renders:
 *  what happened, and at most one thing to do about it. */
const status = signal<{ text: string; action: { label: string; act: () => void } | null }>({
  text: "",
  action: null,
});
const say = (text: string): void => status.set({ text, action: null });
const offer = (label: string, act: () => void): void => status.set({ ...status.get(), action: { label, act } });
const hush = (): void => status.set({ text: "", action: null });

const ui = screen(document.body, () => {
  const said = status.get();
  return html`
    <pewter-status
      ?hidden=${!said.text && !said.action}
      .text=${said.text}
      .action=${said.action?.label ?? ""}
      .onact=${said.action?.act ?? null}
    ></pewter-status>
    <section class="screen" ?hidden=${phase.get() !== "picking"}>
      <h1>Terminal</h1>
      <p class="note">${note.get()}</p>
      <pewter-menu .choices=${places.get()} .onpick=${(where: string | null) => void open(where)}></pewter-menu>
    </section>
    <!-- Always rendered, hidden while the picker is up. The emulator's own
         canvas lives inside this div and lit never touches it: the template
         declares no children here, so there is no part of it for a redraw to
         replace. A version of this that swapped the two faces with a
         conditional would throw the running terminal away every time the
         status line changed. -->
    <div id="term" ?hidden=${phase.get() !== "running"}></div>
  `;
});

/** Where a shell can start: the pewter itself, or a project under `repos/`.
 *  Asked fresh every time the picker shows, so a project cloned since the
 *  last shell is on the list. */
async function choose(): Promise<void> {
  phase.set("picking");
  note.set("asking the host…");
  try {
    const { repos } = await pewt.repos.list();
    note.set("a shell is your own account on this machine — the host asks before it opens one");
    places.set([{ value: null, label: "this pewter" }, ...repos.map((r) => ({ value: r.name, label: r.name }))]);
  } catch (e) {
    note.set(explain(e));
  }
}

/** One shell, for as long as it runs. The tab is the terminal while it does,
 *  and the picker comes back when it ends, under the code it ended on. */
async function open(repo: string | null): Promise<void> {
  phase.set("running");
  say("waiting — the host asks on its own terminal before it opens a shell");
  // The screen first: `#term` is hidden until the draw that this phase
  // change causes, and an emulator fitted to a hidden box measures nothing.
  await ui.drawn();

  // Fitted before the call, so the pty is born at the size the tab actually
  // has rather than resized into it a moment later.
  const host = document.getElementById("term")!;
  const term = new Terminal({
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  try {
    const shell = await pewt.shell({
      ...(repo ? { repo } : {}),
      cols: term.cols,
      rows: term.rows,
      onData: (bytes) => term.write(bytes),
    });
    hush();
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
    offer("new shell", () => {
      term.dispose();
      void choose();
    });
  } catch (e) {
    // A refusal is a normal ending: the human at the host's terminal said
    // no, or there is no host. It arrives in the operation's own words —
    // and a shell that never started leaves nothing on screen worth
    // keeping, so the picker comes straight back under the reason.
    say(explain(e));
    term.dispose();
    await choose();
  }
}

// Opened with `{repo}` — the repos row's shell verb (#198) — this screen
// skips its picker and goes straight there. Opened bare, it offers the
// choice. Either way the host asks before anything starts: the argument
// opened a screen, not a process.
const openedWith = (await args) as { repo?: unknown } | undefined;
if (openedWith && typeof openedWith.repo === "string") {
  await open(openedWith.repo);
} else {
  await choose();
}
