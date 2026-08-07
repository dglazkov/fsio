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
export declare function screen(root: HTMLElement | DocumentFragment, view: () => unknown): Screen;
//# sourceMappingURL=screen.d.ts.map