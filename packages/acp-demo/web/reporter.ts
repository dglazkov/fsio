// Cooperative-verification reporter (same files, same contract as the
// terminal demo's and the workbench's). Self-reports into
// <folder>/.fsio/client/<clientId>/{log.txt,report.json} — the page reports,
// the native side reads verdicts (TESTING.md).
import { signal } from "@lit-labs/signals";
import { hasObserver } from "@fsio/client";
import { notice } from "./state";

/** Nerd log text (status bar ⓘ popover renders it). */
export const logText = signal("");

let lastStep = "loading";

class Reporter {
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
      await this.write("log.txt", this.lines.join("\n") + "\n");
      await this.write(
        "report.json",
        JSON.stringify(
          {
            updated: new Date().toISOString(),
            clientId: this.clientId,
            page: "acp-demo",
            origin: location.origin,
            userAgent: navigator.userAgent,
            hasObserver,
            currentStep: lastStep,
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

  private async write(name: string, text: string): Promise<void> {
    const fh = await this.dir!.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>);
    await w.close();
  }
}
export const reporter = new Reporter();

export function log(...a: unknown[]): void {
  const line = a.map((x) => (x instanceof Error ? (x.stack ?? x.message) : String(x))).join(" ");
  logText.set(logText.get() + line + "\n");
  console.log(...a);
  reporter.log(line);
}

export function step(s: string): void {
  lastStep = s;
  log(`— ${s}`);
}

export function showNotice(msg: string, hint = ""): void {
  notice.set({ msg, hint });
  reporter.event("notice", { msg, hint, step: lastStep });
}
