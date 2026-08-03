// Escape, and a click anywhere else, put a popover away.
//
// Neither used to, on either page: the only way to close one was to hit the
// control that opened it, which is a trap with a pointer and a dead end
// without. Both pages then grew the same twelve lines to fix it, which is
// what this is.
//
// A controller rather than a base class because the components that need it
// already extend LitElement or SignalWatcher(LitElement), and a second
// inheritance step to deliver two event listeners is the wrong trade.
import type { ReactiveController, ReactiveControllerHost } from "lit";

type Host = ReactiveControllerHost & HTMLElement;

export class Dismiss implements ReactiveController {
  #host: Host;
  #isOpen: () => boolean;
  #shut: () => void;

  constructor(host: Host, isOpen: () => boolean, shut: () => void) {
    this.#host = host;
    this.#isOpen = isOpen;
    this.#shut = shut;
    host.addController(this);
  }

  hostConnected(): void {
    this.#host.addEventListener("keydown", this.#esc);
    // Capture: a click that opens something else must close this one first,
    // and the target's own handler may stop propagation on the way up.
    document.addEventListener("click", this.#outside, true);
  }

  hostDisconnected(): void {
    this.#host.removeEventListener("keydown", this.#esc);
    document.removeEventListener("click", this.#outside, true);
  }

  #esc = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.#isOpen()) return;
    // Swallowed, so Escape does not also reach a modal behind this one.
    e.stopPropagation();
    this.#shut();
  };

  #outside = (e: Event): void => {
    if (!this.#isOpen()) return;
    // composedPath, not target: a click inside this component's shadow root
    // reports the host as its target from outside, but a click on a child
    // custom element does not.
    if (e.composedPath().includes(this.#host)) return;
    this.#shut();
  };
}
