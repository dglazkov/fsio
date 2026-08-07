// The kit's typed surface: custom elements an extension can see.
//
// Importing this module registers them — `import "pewter-ui"` is the whole
// setup — and the HTMLElementTagNameMap augmentation at the bottom is the
// discovery rail: `document.querySelector("pewter-menu")` comes back typed,
// the editor completes `.choices`, and `pewt check` fails a misuse the same
// way it fails a wrong `pewt.*` call. That is why these are elements rather
// than more classes in the stylesheet: a class name is a string nothing
// checks, and an element is an API.
//
// Light DOM, on purpose. Each element renders ordinary markup into itself —
// the same markup the scaffolded screens used to write by hand — so your
// stylesheet restyles any of it by specificity, and devtools shows real
// rows rather than a shadow boundary. pewter-ui/style.css styles them
// through the same selectors a hand-written screen uses.
/** `<pewter-status>` — one quiet line above a screen: what just happened,
 *  and at most one thing to do about it.
 *
 *      status.say("the shell ended — exit 0");
 *      status.offer("new shell", () => again());
 *
 *  Extracted from the terminal and agent screens, which had each written
 *  exactly this line, its span, and its one button. */
export class PewterStatus extends HTMLElement {
    #said;
    #verb;
    #act = null;
    connectedCallback() {
        this.#ensure();
    }
    /** The children, built once — in connectedCallback for an element from
     *  markup, or on first use for one made before it is in the document. */
    #ensure() {
        if (!this.#said || !this.#verb) {
            this.#said = document.createElement("span");
            this.#verb = document.createElement("button");
            this.#verb.hidden = true;
            this.#verb.addEventListener("click", () => {
                // The button goes first, then the act — both screens this was
                // extracted from hid it before doing anything else.
                this.#verb.hidden = true;
                const act = this.#act;
                this.#act = null;
                act?.();
            });
            this.replaceChildren(this.#said, this.#verb);
        }
        return { said: this.#said, verb: this.#verb };
    }
    /** Show the line with these words. Clears any offer — a new line is a new
     *  state, and the button that belonged to the old one goes with it. */
    say(text) {
        const { said, verb } = this.#ensure();
        said.textContent = text;
        verb.hidden = true;
        this.#act = null;
        this.hidden = false;
    }
    /** Put one action beside the words, without changing them. */
    offer(label, act) {
        const { verb } = this.#ensure();
        verb.textContent = label;
        verb.hidden = false;
        this.#act = act;
        this.hidden = false;
    }
    /** The line has nothing to say. */
    hide() {
        this.hidden = true;
    }
}
/** `<pewter-menu>` — a list of choices, each row one full-width button.
 *
 *      menu.choices = [{ value: null, label: "this pewter" }, ...names];
 *      menu.onpick = (value) => open(value);
 *
 *  Setting `hints` instead replaces the list with plain rows — for when
 *  there is nothing to pick and the useful thing is to say why, which is
 *  the agent screen's empty roster. Extracted from the terminal and agent
 *  pickers, which had each written this list, its rows, and its refresh. */
export class PewterMenu extends HTMLElement {
    #list;
    #choices = [];
    /** Called with the picked row's value. One handler, not a bus: the
     *  screens this serves route every pick the same place. */
    onpick = null;
    connectedCallback() {
        this.#ensure();
    }
    #ensure() {
        if (!this.#list) {
            // A real <ul class="menu"> in the light DOM: exactly what the screens
            // wrote by hand, so the stylesheet needs no second spelling for it.
            this.#list = document.createElement("ul");
            this.#list.className = "menu";
            this.replaceChildren(this.#list);
        }
        return this.#list;
    }
    get choices() {
        return this.#choices;
    }
    set choices(rows) {
        this.#choices = rows;
        const list = this.#ensure();
        list.replaceChildren();
        for (const row of rows) {
            const li = document.createElement("li");
            const button = document.createElement("button");
            button.textContent = row.label;
            button.addEventListener("click", () => this.onpick?.(row.value));
            li.append(button);
            list.append(li);
        }
    }
    /** Plain rows in place of the choices: there is nothing to pick, and
     *  these lines say why. */
    set hints(lines) {
        this.#choices = [];
        const list = this.#ensure();
        list.replaceChildren();
        for (const line of lines) {
            const li = document.createElement("li");
            li.className = "hint";
            li.textContent = line;
            list.append(li);
        }
    }
}
/** Each tab is its own document with its own registry, so this runs once
 *  per tab — the guard is for the harmless second import, not for clashes. */
const define = (tag, ctor) => {
    if (!customElements.get(tag))
        customElements.define(tag, ctor);
};
define("pewter-status", PewterStatus);
define("pewter-menu", PewterMenu);
//# sourceMappingURL=index.js.map