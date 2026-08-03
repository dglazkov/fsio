// Cooperative-verification reporter: the page's half of the loop in
// TESTING.md. Self-reports into
// <folder>/.fsio/client/<clientId>/{log.txt,report.json} — the page reports,
// the native side reads verdicts.
//
// Both demos had this file, identical but for the `page` string and the name
// of the one hook that lists what the page currently holds. So those are the
// two arguments, and everything else — the per-load client directory, the
// 1 s flush, the 500-line and 100-event caps, the swallowed write errors —
// is the same code it always was.
import { signal } from "@lit-labs/signals";
import type { Signal } from "@lit-labs/signals";

export interface ReporterOptions {
  /** which demo is reporting; lands in report.json as `page`. */
  page: string;
  /** what to call the list of things this page is holding — "tabs" for
   *  shells, "conversations" for agents. The native side reads it by name. */
  summaryKey: string;
  /** constants worth having in every report (`hasObserver`, say). Read once
   *  per flush, so a getter that changes is fine too. */
  facts?: () => Record<string, unknown>;
}

export class Reporter {
  // Per-page dir (#39): two pages on one shared dir must not fight over the
  // same report files (one writer per file, F8). Same id shape as sessions.
  readonly clientId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  lines: string[] = [];
  events: Record<string, unknown>[] = [];
  dirty = false;
  dir: FileSystemDirectoryHandle | null = null;
  flushing = false;
  lastWrite = 0;
  timer: ReturnType<typeof setInterval> | undefined;
  lastStep = "loading";
  /** Injected by whichever module owns the open sessions (avoids an import
   *  cycle): live per-session state, so a cooperative run can read multi-tab
   *  behaviour straight out of report.json. N of anything is exactly what the
   *  native side cannot otherwise see. */
  summary: () => Record<string, unknown>[] = () => [];

  readonly #opts: ReporterOptions;

  constructor(opts: ReporterOptions) {
    this.#opts = opts;
  }

  async attach(fsioDir: FileSystemDirectoryHandle): Promise<void> {
    const clientRoot = await fsioDir.getDirectoryHandle("client", { create: true });
    this.dir = await clientRoot.getDirectoryHandle(this.clientId, { create: true });
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.flush(), 1000);
    this.dirty = true;
    void this.flush();
  }

  log(line: string): void {
    this.lines.push(`${new Date().toISOString()} ${line}`);
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
    this.dirty = true;
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    this.events.push({ at: new Date().toISOString(), type, ...data });
    if (this.events.length > 100) this.events.splice(0, this.events.length - 100);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dir || this.flushing) return;
    if (!this.dirty && Date.now() - this.lastWrite < 5000) return;
    this.flushing = true;
    this.dirty = false;
    this.lastWrite = Date.now();
    try {
      await this.#write("log.txt", this.lines.join("\n") + "\n");
      await this.#write(
        "report.json",
        JSON.stringify(
          {
            updated: new Date().toISOString(),
            clientId: this.clientId,
            page: this.#opts.page,
            origin: location.origin,
            userAgent: navigator.userAgent,
            ...(this.#opts.facts?.() ?? {}),
            currentStep: this.lastStep,
            [this.#opts.summaryKey]: this.summary(),
            events: this.events,
          },
          null,
          2
        )
      );
    } catch {
      // Reporting must never break the thing it reports on.
    } finally {
      this.flushing = false;
    }
  }

  async #write(name: string, text: string): Promise<void> {
    const fh = await this.dir!.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>);
    await w.close();
  }
}

export interface PageReporter {
  reporter: Reporter;
  /** The nerd log, as one string — what the diagnostics popover renders. */
  logText: Signal.State<string>;
  log(...a: unknown[]): void;
  /** Name the thing the page is now doing. Lands in report.json as
   *  `currentStep`, which is what a stuck cooperative run is read by. */
  step(s: string): void;
}

export function createReporter(opts: ReporterOptions): PageReporter {
  const reporter = new Reporter(opts);
  const logText = signal("");
  const log = (...a: unknown[]): void => {
    const line = a.map((x) => (x instanceof Error ? (x.stack ?? x.message) : String(x))).join(" ");
    logText.set(logText.get() + line + "\n");
    console.log(...a);
    reporter.log(line);
  };
  return {
    reporter,
    logText,
    log,
    step: (s: string): void => {
      reporter.lastStep = s;
      log(`— ${s}`);
    },
  };
}
