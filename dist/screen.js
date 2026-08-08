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
import { html, render } from "lit";
import { Signal } from "@lit-labs/signals";
/** What a screen shows when its own view throws.
 *
 *  Styled inline rather than through the kit's stylesheet, because a screen
 *  can throw before anything it imported has had a chance to matter, and an
 *  error message that depends on the thing that broke is not an error
 *  message. The colours are literals for the same reason — a `--pewter-*`
 *  custom property is a promise about a stylesheet being present.
 *
 *  The first line is the message, because that is what a person reads. The
 *  stack is under it, because that is what fixes it. */
function failure(e) {
    const said = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const stack = e instanceof Error && e.stack ? e.stack : "";
    return html `
    <div style="margin:0;padding:1.25rem 1.5rem;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#b3261e;background:#fff0ee;border:1px solid #f2b8b5;border-radius:8px">
      <strong style="display:block;margin-bottom:0.5rem;font-size:1rem">This screen could not draw.</strong>
      <div style="margin-bottom:0.75rem;color:#5f1512">${said}</div>
      ${stack ? html `<pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;opacity:0.85">${stack}</pre>` : nothingAtAll}
      <div style="margin-top:0.85rem;font-size:12px;opacity:0.75">
        It is <code>extensions/</code> in your pewter — the file is yours to read and change.
      </div>
    </div>
  `;
}
/** lit renders `undefined` as nothing, and importing `nothing` for one branch
 *  is more ceremony than the branch is worth. */
const nothingAtAll = undefined;
/** Render `view()` into `root`, and again whenever a signal it read changes.
 *
 *  There is no way to stop it, and that is not an oversight: a screen lives
 *  as long as its tab, and the tab closing takes the whole document with
 *  it.
 *
 *  A `view()` that throws does not leave a blank pane: the reason is rendered
 *  where the screen would have been (`failure`, above). */
export function screen(root, view) {
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
        if (queued)
            return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            draw();
        });
    });
    let waiting = [];
    const draw = () => {
        // A view that throws puts its reason on screen instead of nothing. This
        // is the whole of `failure()`'s reason for existing: before it, a screen
        // that threw left the pane the shell's own background — indistinguishable
        // from a frame that never mounted — and the only record was a console the
        // person who wrote the screen may not be able to reach at all. An agent
        // building an extension cannot open devtools; a human has to think to.
        //
        // The throw still reaches the console, because a stack in devtools is
        // better than a stack in a <pre> when you have devtools open.
        let tree;
        try {
            tree = drawn.get();
        }
        catch (e) {
            console.error("pewter-ui: the screen's view threw", e);
            tree = failure(e);
        }
        render(tree, root);
        // Re-armed after the read, not before: a watcher stops notifying once it
        // has notified, and the read is what tells it which signals to watch
        // this time round.
        watcher.watch(drawn);
        const caught = waiting;
        waiting = [];
        for (const resolve of caught)
            resolve();
    };
    watcher.watch(drawn);
    draw();
    return {
        drawn: () => (queued ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve()),
    };
}
//# sourceMappingURL=screen.js.map