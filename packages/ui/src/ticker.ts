// A slow wall-clock heartbeat for anything that renders "3 minutes ago".
//
// Both file panes had written this: an interval in `connectedCallback` that
// calls `requestUpdate()` and a `clearInterval` in `disconnectedCallback`,
// with the same comment about why. Signals only fire when the data changes,
// and the whole point of a relative timestamp is that it goes stale while the
// data sits perfectly still.
//
// A reactive controller rather than a base class, for the same reason
// `Dismiss` is one: a component already extends `SignalWatcher(LitElement)`
// and has no second `extends` to spend.
import type { ReactiveController, ReactiveControllerHost } from "lit";

/** Slow on purpose. This drives text that changes at the scale of minutes and
 *  a fade measured in seconds; anything faster is a render nobody can see. */
const TICK_MS = 2000;

export class Ticker implements ReactiveController {
  #host: ReactiveControllerHost;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(host: ReactiveControllerHost) {
    (this.#host = host).addController(this);
  }

  hostConnected(): void {
    this.#timer = setInterval(() => this.#host.requestUpdate(), TICK_MS);
  }

  hostDisconnected(): void {
    clearInterval(this.#timer);
  }
}
