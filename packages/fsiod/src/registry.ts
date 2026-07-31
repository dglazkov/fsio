// The workspace registry (D22): the name→path table `fsio share` writes
// and the daemon resolves against.
//
// Two rules shape the whole file. **Names, never paths**: the page cannot
// supply a path (a picked handle has none — D19's decisive wall) and the
// daemon must not disclose one, because the hub is co-tenant-readable and
// a path leaks the user's home directory and project layout. And **never
// substitute a default**: an unresolvable name, a name this client may not
// see, and an omitted name where one is required all end in `1006`, never
// in a spawn that quietly ran somewhere else.
//
// The registry lives in daemon-private state (D20), mode 0600 — it is
// authority, so it cannot live in the granted folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspaceResolver } from "@fsio/host";
import { writeStateFile } from "./state.js";

export const REGISTRY_FILE = "workspaces.json";

/** A registry entry. `profile` names the spawn allow-list / sandbox
 *  template / env policy that governs children started in this workspace
 *  (D22); the profile *content* is a later slice of #71 (absorbed from
 *  #46), so for now every entry names the built-in `default`. */
export interface WorkspaceEntry {
  name: string;
  /** absolute, realpath'd at share time. Never leaves this machine. */
  path: string;
  /** display text for consent UIs; the legitimate need paths were rejected for. */
  label?: string;
  /** may this name appear in the all-tenants `services.json` (D24)? */
  advertise: boolean;
  profile: string;
  addedAt: number;
}

interface RegistryFile {
  version: 1;
  workspaces: WorkspaceEntry[];
}

/** Names are user-facing identifiers that travel on the wire: lowercase,
 *  no separators that could be read as a path, bounded. */
const NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes("..");
}

/** Derive a default name from a directory. Mangling is fine *here* (the
 *  user sees the result and can override with `--name`); an explicit
 *  `--name` is never silently mangled. */
export function defaultName(dir: string): string {
  const base = path
    .basename(path.resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 64);
  return base || "workspace";
}

/** Client-supplied text that goes back out in an error: bound it and strip
 *  control characters, so a hostile name cannot smuggle escapes through
 *  status.json into someone's terminal. */
const echoSafe = (s: string): string => s.replace(/[\p{C}]/gu, "").slice(0, 64);

const within = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export interface AddOptions {
  dir: string;
  name?: string;
  label?: string;
  advertise?: boolean;
  profile?: string;
  /** replace an existing entry of the same name. */
  replace?: boolean;
}

export class Registry {
  readonly file: string;
  private entries: WorkspaceEntry[] = [];
  private mtimeMs = -1;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, REGISTRY_FILE);
    this.reload();
  }

  /** Re-read when the file changed on disk. The daemon resolves through
   *  this, so `fsio share` takes effect at the next spawn judgment rather
   *  than at the next daemon restart — the same "revocation bites now"
   *  discipline D23 requires of grants. */
  reload(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.entries = [];
      this.mtimeMs = -1;
      return;
    }
    if (st.mtimeMs === this.mtimeMs) return;
    this.mtimeMs = st.mtimeMs;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as RegistryFile;
      // Unknown fields are ignored, in every file and both directions (D25).
      this.entries = (parsed.workspaces ?? []).filter((e) => e && typeof e.path === "string" && isValidName(e.name));
    } catch {
      this.entries = [];
    }
  }

  list(): readonly WorkspaceEntry[] {
    this.reload();
    return this.entries;
  }

  get(name: string): WorkspaceEntry | undefined {
    return this.list().find((e) => e.name === name);
  }

  private save(): void {
    const doc: RegistryFile = { version: 1, workspaces: [...this.entries].sort((a, b) => a.name.localeCompare(b.name)) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeStateFile(this.file, JSON.stringify(doc, null, 2) + "\n");
    this.mtimeMs = fs.statSync(this.file).mtimeMs;
    this.entries = doc.workspaces;
  }

  /** Register a directory. `hubDir` is checked, not stored: a workspace
   *  that *contains* the hub would put the transport inside the child's
   *  write reach, and the threat model's "$HOME carve-outs are delayed
   *  sandbox escapes" applies with more force to $HOME itself. */
  add(opts: AddOptions, hubDir: string): WorkspaceEntry {
    const resolved = path.resolve(opts.dir);
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      throw new Error(`no such directory: ${resolved}`);
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`not a directory: ${resolved}`);

    const home = fs.realpathSync(os.homedir());
    if (real === path.parse(real).root) throw new Error("refusing to share the filesystem root");
    if (real === home) {
      throw new Error(
        "refusing to share your home directory — a workspace is a project folder, and $HOME hands every file in it, " +
          "plus the shell rc files a later unsandboxed process executes, to any granted origin (spec: threat model)"
      );
    }
    let hubReal = path.resolve(hubDir);
    try {
      hubReal = fs.realpathSync(hubReal);
    } catch {}
    if (within(real, hubReal)) {
      throw new Error(`refusing to share ${real}: it contains the hub (${hubReal}), so a child could rewrite its own transport (D6)`);
    }

    const name = opts.name ?? defaultName(real);
    if (!isValidName(name)) {
      throw new Error(`invalid workspace name: ${echoSafe(name)} (lowercase letters, digits, . _ - ; up to 64 chars)`);
    }
    const existing = this.get(name);
    if (existing && !opts.replace && existing.path !== real) {
      throw new Error(`workspace "${name}" already points at ${existing.path} — pick another with --name, or pass --replace`);
    }
    const entry: WorkspaceEntry = {
      name,
      path: real,
      ...(opts.label ? { label: opts.label } : {}),
      advertise: opts.advertise ?? true,
      profile: opts.profile ?? "default",
      addedAt: existing?.addedAt ?? Date.now(),
    };
    this.entries = [...this.entries.filter((e) => e.name !== name), entry];
    this.save();
    return entry;
  }

  remove(name: string): boolean {
    this.reload();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.name !== name);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  /** The D22 hook the host spawns through. Synchronous by contract (the
   *  host resolves the same root for the policy's `info` and for the
   *  actual spawn), and it answers with a *reason*, never a fallback. */
  resolver(): WorkspaceResolver {
    return (name) => {
      const all = this.list();
      if (name === undefined || name === "") {
        // Omission is only resolvable when there is exactly one subject it
        // could mean. Two entries and no name is `1006`, not entry zero.
        if (all.length === 1) return { root: all[0]!.path, name: all[0]!.name };
        if (all.length === 0) return { error: "this host serves no workspaces — run `fsio share <dir>` on the machine" };
        return { error: `name a workspace: this host serves ${all.length}` };
      }
      const entry = all.find((e) => e.name === name);
      // Deliberately not "did you mean…": the error must not enumerate
      // workspaces to a client that was not told about them. Advertised
      // names live in services.json (D24); per-origin visibility is a
      // property of the grant (D23), and is where this hook grows next.
      if (!entry) return { error: `unknown workspace: ${echoSafe(name)}` };
      return { root: entry.path, name: entry.name };
    };
  }
}
