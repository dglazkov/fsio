// A screen that redraws itself when the state it read changes.
//
// This is the other half of the kit, and the one a scaffolded extension
// actually spends its day in. The elements above are lit components with
// shadow roots; a *screen* is not a component — it is the page inside a tab,
// and it renders into the light DOM on purpose, so `extensions/<name>/
// style.css` goes on styling it with ordinary selectors and the file you
// edit is still the file you see.
//
// What it replaces is a shape every scaffolded screen had written: a handful
// of `document.getElementById` handles at the top, and a `refresh()` that
// rebuilt rows with `createElement` and toggled `hidden` from six places.
// The bug that shape invites is the one where two of those places disagree
// about what is on screen. Here there is one description of the screen and
// one place each fact lives, and lit does the difference:
//
//     const repos = signal<Repo[] | null>(null);
//
//     screen(document.body, () => html`
//       <h1>Projects</h1>
//       <ul>${repos.get()?.map((r) => html`<li>${r.name}</li>`)}</ul>
//     `);
//
//     repos.set(await pewt.repos.list().then((r) => r.repos));  // the screen follows
//
// **Why this and not `SignalWatcher(LitElement)`.** That mixin is the right
// answer when the thing rendering is a component with a shadow root — it is
// what `<pewter-status>` would use if it held signals. A screen has no
// shadow root and no host element to be, so what it needs is lit-html's
// `render()` plus something to call it again at the right moment. That
// something is thirty lines, and this is them.
import { render } from "lit";
import { Signal } from "@lit-labs/signals";

/** A screen, once it is on the page. */
export interface Screen {
  /** Resolves when the screen has caught up with the state — immediately if
   *  it already has.
   *
   *  This is `updateComplete` for something that is not a component, and it
   *  is here for the one thing a template cannot do: measure. A draw is a
   *  microtask away from the write that caused it, so a screen that reveals
   *  a box and then asks how big it is measures the box it had before —
   *  which for the terminal extension means fitting an emulator to a hidden
   *  element and getting a garbage size back. Await this in between. */
  drawn(): Promise<void>;
}

/** Render `view()` into `root`, and again whenever a signal it read changes.
 *
 *  There is no way to stop it, and that is not an oversight: a screen lives
 *  as long as its tab, and the tab closing takes the whole document with
 *  it. */
export function screen(root: HTMLElement | DocumentFragment, view: () => unknown): Screen {
  // The template as a computed: reading it is what subscribes to every
  // signal the view touched, and it re-subscribes on every draw — so a
  // branch that reads a signal only sometimes is still watched exactly when
  // it is on screen.
  const drawn = new Signal.Computed(view);

  // Coalesced to one draw per microtask. Three signals written in a row are
  // one state, and rendering the two states in between would be visible in
  // the worst case and wasted in every other.
  let queued = false;
  const watcher = new Signal.subtle.Watcher(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      draw();
    });
  });

  let waiting: (() => void)[] = [];

  const draw = (): void => {
    render(drawn.get(), root);
    // Re-armed after the read, not before: a watcher stops notifying once it
    // has notified, and the read is what tells it which signals to watch
    // this time round.
    watcher.watch(drawn);
    const caught = waiting;
    waiting = [];
    for (const resolve of caught) resolve();
  };

  watcher.watch(drawn);
  draw();

  return {
    drawn: () => (queued ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve()),
  };
}
