// What this page knows about itself: what a person is looking at, and the
// page's own log.
//
// This page had no such component. The "i" was two lines inline in the app
// shell's header — a bare div of the whole log with an inline style on it —
// and the theme switch sat beside it in the header proper, at the weight of
// the folder you are working in. Both were the odd page out: the other two
// demos keep this material in the corner and say why (nothing in here is
// needed to *use* the page; it is needed when the page is behaving oddly).
//
// The corner, the popover, the theme switch and the log are `@fsio/ui`'s. What
// is this page's is the one paragraph the other two both have and this one did
// not, which for this demo is the load-bearing one: the whole point is which
// half of what you are looking at survives the folder going away, and nothing
// on the screen says that out loud.
import { LitElement, html, css } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { diagBody, tokens } from "@fsio/ui";
import { app } from "../state";
import { logText } from "../reporter";

class ActuatorDetails extends SignalWatcher(LitElement) {
  static override styles = [tokens, diagBody, css`:host { display: contents; }`];

  override render(): TemplateResult {
    const held = app.get().held.length;
    return html`<fsio-details
      label="what this page knows: what you're looking at, and the page log"
      .log=${logText.get()}
    >
      <h3>what am I looking at?</h3>
      <p>
        An ordinary little app — and a terminal on your machine can drive it.
        Type <code>actuator tabs add …</code> in the folder you granted and a
        tab appears here. There is no server in between: the command is written
        into <em>that folder</em>, a helper hands it up, and this page applies
        it. Nothing in the app has a “remote” path — a command from the
        terminal lands in exactly the same function a click does.
      </p>
      <p>
        The direction is the point. The other two demos have the page reach
        down and run things on your machine; here the machine reaches up and
        changes what the page shows — and the page's state never leaves the
        browser. What travelled was the <em>asking</em>.
      </p>
      <p>
        Which is why the pane on the right has two halves and never merges
        them. The top half is your disk, readable only because you granted this
        page one folder. The bottom half is
        ${held === 0
          ? html`what the page has custody of — nothing yet. Fling a file
              (<code>actuator fling ~/some-file</code>) and it lands there.`
          : html`the ${held} file${held === 1 ? "" : "s"} the page has custody
              of, in this browser's own storage.`}
        Revoke the grant, quit the helper, unplug the machine: the top half
        empties and the bottom half is untouched.
      </p>
      <div slot="foot" class="foot">
        an <a href="https://github.com/dglazkov/fsio">fsio</a> demo · the
        measurement workbench lives in the repo (<code>scripts/dev.sh</code>)
      </div>
    </fsio-details>`;
  }
}

customElements.define("actuator-details", ActuatorDetails);
