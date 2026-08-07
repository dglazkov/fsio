#!/usr/bin/env node
// pewt — generated bundle; source: packages/pewt (github.com/dglazkov/fsio)

// dist/cli.js
import path16 from "node:path";

// dist/ops.js
import { asTabCommand, bodyLabel, describeGrant, grantId as grantId2, shellSpec, sizeText } from "pewter";

// dist/agents.js
import fs from "node:fs";
import path from "node:path";
var ADAPTERS = [
  {
    name: "claude-agent-acp",
    pkg: "@agentclientprotocol/claude-agent-acp",
    bin: "claude-agent-acp",
    title: "Claude Code (ACP adapter)",
    // F30, measured by acp-demo at 0.64.0: it asks, and the client renders
    // the question. Caveat the roster cannot carry: only in manual permission
    // mode, which comes from the operator's own Claude Code configuration.
    asks: true,
    measured: "0.64.0"
  },
  {
    name: "pi-acp",
    pkg: "pi-acp",
    bin: "pi-acp",
    title: "pi coding agent (ACP adapter)",
    // https://github.com/dglazkov/fsio/issues/100, measured by acp-demo at
    // 0.0.32: zero `session/request_permission` and zero `fs/*` across a
    // driven session, because it reads and edits with its own hands.
    asks: false,
    measured: "0.0.32"
  }
];
var installLine = (a) => `npm i ${a.pkg}`;
function roster(p) {
  return ADAPTERS.map((a) => {
    const found = resolve(p, a);
    return {
      name: a.name,
      title: a.title,
      pkg: a.pkg,
      install: installLine(a),
      installed: found !== null,
      version: found?.version ?? null,
      asks: a.asks,
      measured: a.measured,
      unmeasured: found !== null && found.version !== a.measured
    };
  });
}
var findAdapter = (name) => typeof name === "string" ? ADAPTERS.find((a) => a.name === name) ?? null : null;
function resolve(p, adapter) {
  const bin = path.join(p.root, "node_modules", ".bin", adapter.bin);
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    return null;
  }
  return { bin, version: versionOf(p, adapter) };
}
function versionOf(p, adapter) {
  try {
    const manifest = path.join(p.root, "node_modules", ...adapter.pkg.split("/"), "package.json");
    const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

// dist/bundle.js
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs3 from "node:fs/promises";
import path3 from "node:path";

// dist/pewter.js
import fs2 from "node:fs";
import path2 from "node:path";
var NotAPewter = class extends Error {
  dir;
  hint;
  constructor(dir, message, hint) {
    super(message);
    this.dir = dir;
    this.hint = hint;
    this.name = "NotAPewter";
  }
};
var paths = (root) => ({
  root,
  name: path2.basename(root),
  fsio: path2.join(root, ".fsio"),
  state: path2.join(root, ".pewter"),
  build: path2.join(root, ".pewter", "build"),
  grants: path2.join(root, ".pewter", "grants.json"),
  repos: path2.join(root, "repos"),
  extensions: path2.join(root, "extensions")
});
function pewterAt(dir) {
  let raw;
  try {
    raw = fs2.readFileSync(path2.join(dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== "object" || !("pewter" in pkg))
    return null;
  return paths(path2.resolve(dir));
}
function findPewter(from2 = process.cwd()) {
  let dir = path2.resolve(from2);
  for (; ; ) {
    const found = pewterAt(dir);
    if (found)
      return found;
    const up = path2.dirname(dir);
    if (up === dir)
      break;
    dir = up;
  }
  throw new NotAPewter(path2.resolve(from2), "this is not a pewter", "`pewt` runs inside a pewter and nowhere else. Make one: npm create pewt@latest ~/dev/tinkering");
}
function ensureState(p) {
  fs2.mkdirSync(p.build, { recursive: true });
}

// dist/bundle.js
var BundleError = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "BundleError";
  }
};
var NAME = /^[a-z0-9][a-z0-9-]*$/;
async function bundleExtension(p, name) {
  if (!NAME.test(name)) {
    throw new BundleError("bad_name", `${JSON.stringify(name)} is not an extension name`, "an extension is a directory under extensions/, named in lowercase with hyphens");
  }
  const src = path3.join(p.extensions, name);
  const html = path3.join(src, "index.html");
  const entry = path3.join(src, "main.ts");
  for (const [file, what] of [
    [html, "index.html"],
    [entry, "main.ts"]
  ]) {
    if (!await exists(file)) {
      throw new BundleError("no_extension", `extensions/${name}/ has no ${what}`, "an extension is an index.html and a main.ts \u2014 `pewt ext new` writes both");
    }
  }
  const out = path3.join(p.build, `${name}.html`);
  const rel = `.pewter/build/${name}.html`;
  const newest = await newestMtime(src);
  const built = await mtime(out);
  if (built !== null && newest !== null && built >= newest) {
    const bytes2 = await fs3.readFile(out);
    return { name, path: rel, bytes: bytes2.length, hash: digest(bytes2), rebuilt: false };
  }
  const t0 = Date.now();
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    // Nothing is written — the HTML is — but naming an outdir is what makes
    // the in-memory outputs have real names to sort by. Without it esbuild
    // calls the whole result `<stdout>` and the CSS has nowhere to go.
    outdir: p.build,
    // Paths in the bundle's own comments are relative to the pewter rather
    // than to whoever's machine this is. That keeps the hash below a
    // property of the source, so two people with the same pewter get the
    // same bundle.
    absWorkingDir: p.root,
    // Resolve through a linked package as if it lived where it is linked.
    //
    // A pewter's own `node_modules` is the one copy of anything. That is
    // free when every package came from npm, and it stops being free the
    // moment one of them is a `file:` link into a checkout — `create-pewt
    // --link`, which is how this repository is worked on. esbuild follows a
    // symlink to its real path by default, so `pewter-ui`'s own `import
    // "lit"` would resolve out of the *checkout's* node_modules while the
    // extension beside it resolves out of the *pewter's*: two copies of lit
    // and two of the signals graph in one bundle.
    //
    // Two copies is not a size problem, it is a silence problem. A signal
    // written through one graph is not read by a computed in the other, so
    // the screen renders once and then never again — no error, nothing in
    // the console, just a page that stopped. Measured, not feared.
    //
    // Keeping the symlink path makes resolution walk up from where the
    // package is *installed*, which is what a peer dependency means. It
    // changes nothing for a pewter whose packages all came from npm: there
    // are no symlinks in that tree to preserve.
    preserveSymlinks: true,
    // The page is Chromium-only anyway — it needs the File System Access API
    // to exist at all — so there is nothing to transpile down to.
    target: "es2022",
    platform: "browser",
    write: false,
    // An extension is read by whoever wants to know what it does, and an
    // agent wrote some of them. Keep the names.
    minify: false,
    logLevel: "silent"
  });
  const js = result.outputFiles.filter((f) => f.path.endsWith(".js")).map((f) => f.text).join("\n");
  const css = result.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
  const page = inline(await inlineLinks(await fs3.readFile(html, "utf8"), src), js, css);
  ensureState(p);
  const bytes = Buffer.from(page, "utf8");
  await fs3.writeFile(out, bytes);
  return { name, path: rel, bytes: bytes.length, hash: digest(bytes), rebuilt: true, ms: Date.now() - t0 };
}
async function inlineLinks(html, dir) {
  const links = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi)];
  let out = html;
  for (const [tag] of links) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || /^[a-z]+:|^\/\//i.test(href))
      continue;
    const rel = href.replace(/^\.\//, "");
    if (rel.startsWith("/") || rel.split("/").includes(".."))
      continue;
    const text = await fs3.readFile(path3.join(dir, rel), "utf8").catch(() => null);
    if (text === null)
      continue;
    out = out.replace(tag, () => `<style>
${text}
</style>`);
  }
  return out;
}
function inline(html, js, css) {
  const style = css.trim() ? `<style>
${css}
</style>
` : "";
  const script = `<script type="module">
${escapeScript(js)}
</script>`;
  const tag = /<script\b[^>]*\bsrc\s*=\s*["']\.?\/?main\.(ts|js)["'][^>]*>\s*<\/script>/i;
  const withScript = tag.test(html) ? html.replace(tag, () => script) : insertBefore(html, "</body>", script);
  return style ? insertBefore(withScript, "</head>", style) : withScript;
}
var escapeScript = (js) => js.replace(/<\/(script)/gi, "<\\/$1");
function insertBefore(html, close, insert) {
  const at = html.toLowerCase().lastIndexOf(close);
  return at === -1 ? `${html}
${insert}
` : `${html.slice(0, at)}${insert}
${html.slice(at)}`;
}
var digest = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 12);
var exists = (file) => fs3.access(file).then(() => true, () => false);
var mtime = (file) => fs3.stat(file).then((s) => s.mtimeMs, () => null);
async function newestMtime(dir) {
  let newest = null;
  const walk = async (at) => {
    const entries = await fs3.readdir(at, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const file = path3.join(at, e.name);
      if (e.isDirectory()) {
        await walk(file);
      } else {
        const t = await mtime(file);
        if (t !== null && (newest === null || t > newest))
          newest = t;
      }
    }
  };
  await walk(dir);
  return newest;
}

// dist/grants.js
import fs4 from "node:fs";
import { grantId } from "pewter";
var GRANTS_FILE = ".pewter/grants.json";
var FIX = `delete ${GRANTS_FILE} and answer the questions again \u2014 the host asks about everything it does not remember`;
var GrantsError = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "GrantsError";
  }
};
function readGrants(p) {
  let raw;
  try {
    raw = fs4.readFileSync(p.grants, "utf8");
  } catch (e) {
    if (e.code === "ENOENT")
      return [];
    throw new GrantsError("unreadable", `cannot read ${GRANTS_FILE}: ${e instanceof Error ? e.message : String(e)}`, FIX);
  }
  let parsed2;
  try {
    parsed2 = JSON.parse(raw);
  } catch {
    throw new GrantsError("unreadable", `${GRANTS_FILE} is not JSON`, FIX);
  }
  const list = parsed2?.grants;
  if (!Array.isArray(list))
    throw new GrantsError("unreadable", `${GRANTS_FILE} has no "grants" array in it`, FIX);
  return list.map(asGrant);
}
function asGrant(row) {
  const bad = (why) => {
    throw new GrantsError("unreadable", `${GRANTS_FILE} has a grant ${why}`, FIX);
  };
  if (!row || typeof row !== "object")
    return bad("that is not an object");
  const { kind, adapter, repo, granted } = row;
  if (kind !== "run" && kind !== "agent")
    return bad(`with kind ${JSON.stringify(kind)} \u2014 a grant is for a run or an agent`);
  if (kind === "agent" && typeof adapter !== "string")
    return bad("for an agent with no adapter named");
  if (kind === "run" && adapter !== void 0)
    return bad("for a run with an adapter on it");
  if (repo !== void 0 && typeof repo !== "string")
    return bad("whose repo is not a name");
  if (typeof granted !== "string")
    return bad("with no date on it");
  return {
    kind,
    ...typeof adapter === "string" ? { adapter } : {},
    ...typeof repo === "string" ? { repo } : {},
    granted
  };
}
function writeGrants(p, grants) {
  fs4.mkdirSync(p.state, { recursive: true });
  const tmp = `${p.grants}.tmp`;
  fs4.writeFileSync(tmp, `${JSON.stringify({ grants }, null, 2)}
`);
  fs4.renameSync(tmp, p.grants);
}
function standingGrant(grants, want) {
  const id = grantId(want);
  return grants.find((g) => grantId(g) === id) ?? null;
}
function recordGrant(p, want, now2 = (/* @__PURE__ */ new Date()).toISOString()) {
  const grants = readGrants(p);
  const found = standingGrant(grants, want);
  if (found)
    return { grant: found, already: true };
  const grant = { ...want, granted: now2 };
  writeGrants(p, [...grants, grant]);
  return { grant, already: false };
}
function revokeGrant(p, id) {
  const grants = readGrants(p);
  const found = grants.find((g) => grantId(g) === id);
  if (!found) {
    throw new GrantsError("no_grant", `no standing grant called ${JSON.stringify(id)}`, "`pewt grants` lists them, and the id is the first column");
  }
  writeGrants(p, grants.filter((g) => g !== found));
  return found;
}

// dist/repos.js
import { execFile } from "node:child_process";
import fs5 from "node:fs/promises";
import path4 from "node:path";
import { promisify } from "node:util";
var run = promisify(execFile);
async function listRepos(p) {
  let entries;
  try {
    entries = await fs5.readdir(p.repos, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("."))
      continue;
    found.push(await projectAt(p, e.name));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
async function projectAt(p, name) {
  const dir = path4.join(p.repos, name);
  const git = await isGitRepo(dir);
  const manifest = await exists2(path4.join(dir, "package.json"));
  return {
    name,
    git,
    branch: git ? await branchOf(dir) : null,
    scripts: await scriptsOf(dir),
    installed: manifest ? await exists2(path4.join(dir, "node_modules")) : null
  };
}
var exists2 = (at) => fs5.stat(at).then(() => true).catch(() => false);
async function branchOf(dir) {
  try {
    let gitDir = path4.join(dir, ".git");
    if ((await fs5.stat(gitDir)).isFile()) {
      const pointer = (await fs5.readFile(gitDir, "utf8")).trim();
      if (!pointer.startsWith("gitdir:"))
        return null;
      gitDir = path4.resolve(dir, pointer.slice("gitdir:".length).trim());
    }
    const head = (await fs5.readFile(path4.join(gitDir, "HEAD"), "utf8")).trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
  } catch {
    return null;
  }
}
async function scriptsOf(dir) {
  try {
    const pkg = JSON.parse(await fs5.readFile(path4.join(dir, "package.json"), "utf8"));
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}
async function isGitRepo(dir) {
  return await fs5.stat(path4.join(dir, ".git")).then(() => true).catch(() => false);
}
var isProjectName = (name) => name !== "" && !name.startsWith(".") && !/[\\/]/.test(name);
var ReposError = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "ReposError";
  }
};
async function createRepo(p, name) {
  if (!isProjectName(name)) {
    throw new ReposError("bad_name", `${JSON.stringify(name)} is not a project name`, "a project is a directory under repos/ \u2014 one path segment, not hidden");
  }
  await fs5.mkdir(p.repos, { recursive: true });
  const dest = path4.join(p.repos, name);
  try {
    await fs5.mkdir(dest);
  } catch {
    throw new ReposError("exists", `there is already a project named ${name} in this pewter`, "`pewt repos` lists them");
  }
  try {
    await run("git", ["init", "--quiet"], { cwd: dest });
  } catch (e) {
    await fs5.rm(dest, { recursive: true, force: true });
    const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new ReposError("git_failed", `git init failed \u2014 ${why}`, "is git installed on this machine?");
  }
  return projectAt(p, name);
}

// dist/ops.js
var OpError = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "OpError";
  }
};
var define = (d) => ({
  method: d.method,
  cli: d.cli,
  summary: d.summary,
  usage: d.usage ?? "",
  fromArgv: (argv) => d.fromArgv(argv),
  parse: (params) => d.parse(params),
  run: (p, params) => d.run(p, params),
  render: (result) => d.render(result)
});
var definePage = (d) => ({
  method: d.method,
  cli: d.cli,
  summary: d.summary,
  usage: d.usage ?? "",
  fromArgv: (argv) => d.fromArgv(argv),
  parse: (params) => d.parse(params),
  render: (result) => d.render(result)
});
var hostAnswers = (op2) => op2.run !== void 0;
var noParams = () => ({});
function str(params, key) {
  const value = params?.[key];
  if (typeof value !== "string" || value === "") {
    throw new OpError("bad_params", `${key} is required and must be a string`);
  }
  return value;
}
var reposList = define({
  method: "repos.list",
  cli: ["repos"],
  summary: "the projects in this pewter",
  fromArgv: noParams,
  parse: noParams,
  run: async (p) => ({ repos: await listRepos(p) }),
  render: ({ repos }) => {
    if (repos.length === 0) {
      return "no projects yet \u2014 repos/ is empty.\n  Start one:   pewt repos create <name>\n  Clone one:   pewt repos clone <url>";
    }
    const width = Math.max(...repos.map((r) => r.name.length));
    const state = (r) => r.git ? r.branch ?? "detached" : "(not a git repository)";
    const stateWidth = Math.max(...repos.map((r) => state(r).length));
    return repos.map((r) => `  ${r.name.padEnd(width)}  ${state(r).padEnd(stateWidth)}  ${r.scripts.length ? r.scripts.join(", ") : "(no scripts)"}`).join("\n");
  }
});
var reposCreate = define({
  method: "repos.create",
  cli: ["repos", "create"],
  summary: "start a new project in repos/",
  usage: "<name>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0])
      throw new OpError("usage", "repos create takes one project name");
    return { name: argv[0] };
  },
  parse: (params) => ({ name: str(params, "name") }),
  // No question. It is a mkdir and a `git init` in the folder the caller was
  // already granted, and git init executes nothing — the same reasoning that
  // left `ext.bundle` and `pewt check` unasked (#189).
  run: async (p, { name }) => {
    try {
      return { repo: await createRepo(p, name) };
    } catch (e) {
      if (e instanceof ReposError)
        throw new OpError(e.code, e.message, e.hint);
      throw e;
    }
  },
  render: ({ repo }) => `${repo.name} \u2192 repos/${repo.name}/ \u2014 a git repository${repo.branch ? ` on ${repo.branch}` : ""}, ready to work in`
});
var extBundle = define({
  method: "ext.bundle",
  cli: ["ext", "bundle"],
  summary: "build one extension into a single HTML file",
  usage: "<name>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0])
      throw new OpError("usage", "ext bundle takes one extension name");
    return { name: argv[0] };
  },
  parse: (params) => ({ name: str(params, "name") }),
  run: async (p, { name }) => {
    try {
      return await bundleExtension(p, name);
    } catch (e) {
      if (e instanceof BundleError)
        throw new OpError(e.code, e.message, e.hint);
      throw new OpError("build_failed", e instanceof Error ? e.message : String(e));
    }
  },
  render: (b) => `${b.name} \u2192 ${b.path}  (${sizeText(b.bytes)}, ${b.hash})` + (b.rebuilt ? `
  rebuilt in ${b.ms} ms` : "\n  already newer than its sources \u2014 nothing to do")
});
var agentsList = define({
  method: "agents.list",
  cli: ["agents"],
  summary: "the ACP adapters this pewter depends on",
  fromArgv: noParams,
  parse: noParams,
  run: async (p) => ({ agents: roster(p) }),
  render: ({ agents }) => {
    const here = agents.filter((a) => a.installed);
    if (here.length === 0) {
      return [
        "no agents in this pewter \u2014 an adapter is an ordinary dependency, so add one:",
        ...agents.map((a) => `  ${a.install.padEnd(44)}${a.asks ? "asks before it edits" : "edits with its own hands"}`),
        "",
        "It is pinned in your lockfile, `npm rm` removes it, and `git clone && npm i`",
        "brings it back on another machine."
      ].join("\n");
    }
    const width = Math.max(...here.map((a) => a.name.length));
    return here.map((a) => {
      const asks = a.asks ? "asks before it edits" : "edits with its own hands \u2014 nothing will ask you";
      const doubt = a.unmeasured ? ` (measured at ${a.measured}, this is ${a.version ?? "unknown"})` : "";
      return `  ${a.name.padEnd(width)}  ${a.version ?? "?"}  ${asks}${doubt}`;
    }).join("\n");
  }
});
var asOpError = (e) => {
  if (e instanceof GrantsError)
    throw new OpError(e.code, e.message, e.hint);
  throw e;
};
var grantsList = define({
  method: "grants.list",
  cli: ["grants"],
  summary: "the answers this host remembers",
  fromArgv: noParams,
  parse: noParams,
  run: async (p) => {
    try {
      return { grants: readGrants(p) };
    } catch (e) {
      return asOpError(e);
    }
  },
  render: ({ grants }) => {
    if (grants.length === 0) {
      return [
        "no standing grants \u2014 every run and every agent asks on the host's terminal.",
        "  Answer `a` to one of those questions to record one. A shell never gets one:",
        "  it is unconfined, so an `always` there would be `always, anything`."
      ].join("\n");
    }
    const width = Math.max(...grants.map((g) => grantId2(g).length));
    return grants.map((g) => `  ${grantId2(g).padEnd(width)}  ${describeGrant(g)}  \xB7  since ${g.granted.slice(0, 10)}`).join("\n");
  }
});
var grantsRevoke = define({
  method: "grants.revoke",
  cli: ["grants", "revoke"],
  summary: "take back a standing grant",
  usage: "<id>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0])
      throw new OpError("usage", "grants revoke takes one grant id \u2014 `pewt grants` lists them");
    return { id: argv[0] };
  },
  parse: (params) => ({ id: str(params, "id") }),
  run: async (p, { id }) => {
    try {
      return { id, grant: revokeGrant(p, id) };
    } catch (e) {
      return asOpError(e);
    }
  },
  render: ({ id, grant }) => `revoked ${id} \u2014 ${describeGrant(grant)}
  the next one asks on the host's terminal again`
});
var tabParams = (method, what, hint) => (params) => {
  const cmd = asTabCommand(method, params);
  if (!cmd)
    throw new OpError("bad_params", what, hint);
  return cmd.params;
};
var OUTSIDE = "paths are relative to the pewter, and a path that climbs out of it is not one the page can read";
var tabId = (argv, verb) => {
  if (argv.length !== 1 || !argv[0])
    throw new OpError("usage", `tabs ${verb} takes one tab id \u2014 \`pewt tabs\` lists them`);
  return { id: argv[0] };
};
var tabsList = definePage({
  method: "tabs.list",
  cli: ["tabs"],
  summary: "what the page has open",
  fromArgv: noParams,
  parse: tabParams("tabs.list", "tabs takes no parameters"),
  render: ({ tabs, activeId }) => {
    if (tabs.length === 0) {
      return "no tabs \u2014 the page is open and holding nothing.\n  Put something in it:  pewt tabs add <extension>";
    }
    const width = Math.max(...tabs.map((t) => t.title.length));
    return tabs.map((t) => `  ${t.id === activeId ? "\u25B8" : " "} ${t.id}  ${t.title.padEnd(width)}  ${bodyLabel(t.body)}`).join("\n");
  }
});
var tabsAdd = definePage({
  method: "tabs.add",
  cli: ["tabs", "add"],
  summary: "open an extension in a new tab",
  usage: "<extension> [args-json]",
  fromArgv: (argv) => {
    const [name, args, ...extra] = argv;
    if (!name || extra.length > 0) {
      throw new OpError("usage", "tabs add takes an extension name and, optionally, one JSON value the tab opens with");
    }
    if (args === void 0)
      return { name };
    try {
      return { name, args: JSON.parse(args) };
    } catch {
      throw new OpError("usage", `${JSON.stringify(args)} is not JSON \u2014 quote it for your shell, like '{"repo":"fsio"}'`);
    }
  },
  parse: tabParams("tabs.add", "tabs add needs an extension name"),
  // A tab twice is two tabs, so this says which one it made. The build that
  // had to happen first is the page's business and does not show up here —
  // when it fails, this operation is refused with the compile error instead.
  render: ({ id, name, title, active }) => `${name} \u2192 ${id}${title === name ? "" : ` (${title})`}${active ? "" : "  \xB7 left in the strip, not brought forward"}`
});
var tabsUpdate = definePage({
  method: "tabs.update",
  cli: ["tabs", "update"],
  summary: "rename a tab",
  usage: "<id> <title>",
  fromArgv: (argv) => {
    if (argv.length !== 2 || !argv[0] || !argv[1])
      throw new OpError("usage", 'tabs update takes a tab id and a title \u2014 `pewt tabs update tab-9f2c "Build log"`');
    return { id: argv[0], title: argv[1] };
  },
  parse: tabParams("tabs.update", "tabs update needs a tab id and a title"),
  render: ({ id, title }) => `${id} \u2192 ${JSON.stringify(title)}`
});
var tabsClose = definePage({
  method: "tabs.close",
  cli: ["tabs", "close"],
  summary: "close a tab",
  usage: "<id>",
  fromArgv: (argv) => tabId(argv, "close"),
  parse: tabParams("tabs.close", "tabs close needs a tab id"),
  // What is on screen now is the half nobody thinks to ask for and everybody
  // wants next: closing the tab you were looking at moves you somewhere.
  render: ({ id, activeId }) => `closed ${id}${activeId ? `  \xB7 ${activeId} is on screen now` : "  \xB7 the page is holding nothing now"}`
});
var tabsFocus = definePage({
  method: "tabs.focus",
  cli: ["tabs", "focus"],
  summary: "bring a tab forward",
  usage: "<id>",
  fromArgv: (argv) => tabId(argv, "focus"),
  parse: tabParams("tabs.focus", "tabs focus needs a tab id"),
  render: ({ id, title }) => `${id} is on screen \u2014 ${JSON.stringify(title)}`
});
var filePath = (argv, verb) => {
  if (argv.length !== 1 || !argv[0])
    throw new OpError("usage", `${verb} takes one path inside this pewter`);
  return { path: argv[0] };
};
var filesOpen = definePage({
  method: "files.open",
  cli: ["open"],
  summary: "show a file from this pewter, as a window on it",
  usage: "<path>",
  fromArgv: (argv) => filePath(argv, "open"),
  parse: tabParams("files.open", "open needs a path inside this pewter", OUTSIDE),
  // Whether a window was already on it is the half nobody asks for and
  // everybody wants next: `pewt open` twice is one tab, on purpose, and a
  // second id would be the more surprising answer to report.
  render: ({ id, path: path17, reused }) => `${path17} \u2192 ${id}${reused ? "  \xB7 the window already on it, brought forward" : ""}`
});
var filesFling = definePage({
  method: "files.fling",
  cli: ["fling"],
  summary: "give the page a copy of a file, which outlives the file",
  usage: "<path>",
  fromArgv: (argv) => filePath(argv, "fling"),
  parse: tabParams("files.fling", "fling needs a path inside this pewter", OUTSIDE),
  render: ({ fileId, id, name, size, superseded }) => `${name} \u2192 ${fileId} (${sizeText(size)}), in ${id}` + (superseded ? `
  replaced ${superseded} \u2014 the same path, flung again` : "") + "\n  the page holds these bytes now: delete the file, stop the host, revoke the folder, and the tab still works"
});
var filesList = definePage({
  method: "files.list",
  cli: ["files"],
  summary: "the copies the page has custody of",
  fromArgv: noParams,
  parse: tabParams("files.list", "files takes no parameters"),
  render: ({ files }) => {
    if (files.length === 0) {
      return "no copies \u2014 this page holds nothing of its own.\n  Give it one:  pewt fling <path>";
    }
    const width = Math.max(...files.map((f) => f.name.length));
    return files.map((f) => `  ${f.id}  ${f.name.padEnd(width)}  ${sizeText(f.size).padStart(7)}  was ${f.from}`).join("\n");
  }
});
var filesShow = definePage({
  method: "files.show",
  cli: ["files", "show"],
  summary: "put a copy the page holds back in a tab",
  usage: "<file id>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0])
      throw new OpError("usage", "files show takes one file id \u2014 `pewt files` lists them");
    return { id: argv[0] };
  },
  parse: tabParams("files.show", "files show needs a file id"),
  render: ({ id, name, reused }) => `${name} \u2192 ${id}${reused ? "  \xB7 the tab already on it, brought forward" : ""}`
});
var filesDrop = definePage({
  method: "files.drop",
  cli: ["files", "drop"],
  summary: "forget a copy and free its bytes",
  usage: "<file id>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0])
      throw new OpError("usage", "files drop takes one file id \u2014 `pewt files` lists them");
    return { id: argv[0] };
  },
  parse: tabParams("files.drop", "files drop needs a file id"),
  // The tabs are worth saying out loud: dropping bytes closes windows onto
  // them, and a tab vanishing with no line about it is the confusing kind.
  render: ({ id, name, closedTabs }) => `dropped ${name} (${id})` + (closedTabs ? `  \xB7 closed ${closedTabs} tab${closedTabs === 1 ? "" : "s"} showing it` : "")
});
var OPERATIONS = [
  reposList,
  reposCreate,
  extBundle,
  agentsList,
  grantsList,
  grantsRevoke,
  tabsList,
  tabsAdd,
  tabsUpdate,
  tabsClose,
  tabsFocus,
  filesOpen,
  filesFling,
  filesList,
  filesShow,
  filesDrop
];
var byMethod = (method) => OPERATIONS.find((o) => o.method === method);
var runProcess = {
  method: "run",
  cli: ["run"],
  summary: "run a script the project declares",
  usage: "<script>",
  repo: true,
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0])
      throw new OpError("usage", "run takes one script name");
    return { script: argv[0] };
  },
  // The script is checked against the project's package.json when the run is
  // planned (run.ts), which is the only check that means anything: a name
  // that is not in that file is not runnable however well-formed it looks.
  parse: (params) => ({ script: str(params, "script"), ...repoOf(params) })
};
function repoOf(params) {
  const value = params?.["repo"];
  if (value === void 0 || value === null)
    return {};
  if (typeof value !== "string" || value === "")
    throw new OpError("bad_params", "repo must be a project name");
  return { repo: value };
}
var shellProcess = {
  method: "shell",
  cli: ["shell"],
  summary: "open a shell on your machine",
  usage: "",
  repo: true,
  fromArgv: (argv) => {
    if (argv.length > 0)
      throw new OpError("usage", "shell takes no arguments \u2014 `--repo <name>` picks the project");
    return {};
  },
  // The spec that goes on the wire is @fsio/host's, not this table's, so this
  // reads `--repo` and hands it to the one function both front ends translate
  // with (packages/pewter/src/shell.ts). What the host checks is the resolved
  // directory, which is the only check that means anything.
  parse: (params) => shellSpec(repoOf(params))
};
var agentProcess = {
  method: "agent",
  cli: ["agent"],
  summary: "start an ACP agent on a project",
  usage: "[name]",
  repo: true,
  fromArgv: (argv) => {
    if (argv.length > 1)
      throw new OpError("usage", "agent takes at most one adapter name \u2014 `pewt agents` lists them");
    return argv[0] ? { agent: argv[0] } : {};
  },
  // The name is checked against the roster when the agent is planned
  // (agent.ts), which is the only check that means anything: a name nobody
  // lists is not runnable however well-formed it looks.
  parse: (params) => {
    const agent = params?.["agent"];
    if (agent !== void 0 && (typeof agent !== "string" || agent === "")) {
      throw new OpError("bad_params", "agent must be an adapter name");
    }
    return { ...agent !== void 0 ? { agent } : {}, ...repoOf(params) };
  }
};
var cloneProcess = {
  method: "repos.clone",
  cli: ["repos", "clone"],
  summary: "clone a repository into repos/",
  usage: "<url> [name]",
  repo: false,
  fromArgv: (argv) => {
    if (argv.length < 1 || argv.length > 2 || !argv[0]) {
      throw new OpError("usage", "repos clone takes a url and, optionally, a project name");
    }
    return { url: argv[0], ...argv[1] ? { name: argv[1] } : {} };
  },
  // The url and the name are checked against the disk when the clone is
  // planned (clone.ts), which is the only check that means anything: what a
  // url has to be is "something git can fetch", and git is the authority.
  parse: (params) => {
    const name = params?.["name"];
    if (name !== void 0 && (typeof name !== "string" || name === "")) {
      throw new OpError("bad_params", "name must be a project name");
    }
    return { url: str(params, "url"), ...name !== void 0 ? { name } : {} };
  }
};
var installProcess = {
  method: "repos.install",
  cli: ["repos", "install"],
  summary: "npm install in a project \u2014 asked first, unlike clone",
  usage: "<name>",
  repo: false,
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0])
      throw new OpError("usage", "repos install takes one project name \u2014 `pewt repos` lists them");
    return { name: argv[0] };
  },
  // The name is checked against the disk when the install is planned
  // (install.ts) — a project that is not there, or has no manifest, is
  // refused before any question is asked.
  parse: (params) => ({ name: str(params, "name") })
};
var PROCESSES = [runProcess, shellProcess, agentProcess, cloneProcess, installProcess];
var COMMAND_LIST = [
  ...OPERATIONS.map((o) => ({ cli: o.cli, usage: o.usage, summary: o.summary, repo: false })),
  ...PROCESSES.map((o) => ({ cli: o.cli, usage: o.usage, summary: o.summary, repo: o.repo }))
];
function byArgv(argv) {
  const words = (cli) => cli.every((word, i) => argv[i] === word);
  const op2 = OPERATIONS.filter((o) => words(o.cli)).sort((a, b) => b.cli.length - a.cli.length)[0];
  const proc = PROCESSES.filter((o) => words(o.cli)).sort((a, b) => b.cli.length - a.cli.length)[0];
  if (op2 && (!proc || op2.cli.length >= proc.cli.length))
    return { op: op2, rest: argv.slice(op2.cli.length) };
  if (proc)
    return { process: proc, rest: argv.slice(proc.cli.length) };
  return null;
}

// dist/args.js
var COMMANDS = [
  ["serve", "run the host for this pewter"],
  ["check", "compile extensions/ and say what is wrong"],
  ...COMMAND_LIST.map((c) => [[...c.cli, c.usage].filter(Boolean).join(" "), c.summary])
];
var WIDTH = Math.max(...COMMANDS.map(([spelling]) => spelling.length)) + 2;
var USAGE = `pewt \u2014 the command line for a pewter

${COMMANDS.map(([spelling, summary]) => `  pewt ${spelling.padEnd(WIDTH)}${summary}`).join("\n")}

Anywhere:
  --dir <path>   act on the pewter at <path> instead of the one containing
                 the working directory (a development convenience)
  --json         print the result as JSON instead of prose
  --help         this

run, shell, agent:
  --repo <name>  a project under repos/ (default: the pewter itself)
  --dry-run      print what would start, and start nothing

serve:
  --url <base>   where the shell is served from
  --no-open      print the URL and open nothing
  --allow-runs   allow every \`run\` without asking on this terminal
  --allow-shells allow every \`shell\` without asking on this terminal
  --allow-agents allow every \`agent\` without asking on this terminal

The allow flags are separate because these are separate capabilities:
something that was told it could build is not thereby something that can do
anything, or something that can run a coding agent on your projects.

Answering a host's question with \`a\` records a standing grant in
.pewter/grants.json, and questions of that shape are not asked again. A grant
is narrower than any flag: a run's covers one project, an agent's covers one
adapter in one project, and a shell gets none at all \u2014 it is unconfined, so an
\`always\` there would be \`always, anything\`. \`pewt grants\` lists them and
\`pewt grants revoke <id>\` takes one back, which the next question feels.

The file is in .pewter/, which a pewter git-ignores, so a grant does not
travel with a clone. It does travel to a host with no terminal: a background
\`pewt serve\` cannot ask, but it can still honour what you already answered.

\`pewt repos clone\` starts git and asks nothing: a clone fetches and executes
nothing it fetched, and it lands inside repos/. It streams git's own output
and exits with git's code. A url that needs credentials fails in git's words
rather than prompting \u2014 the host runs git with no terminal to ask on, so use
an ssh url if your keys are set up, or a public one.

\`pewt repos install\` is the other half, and it IS asked: npm install runs
lifecycle scripts, which is the first execution of what a clone fetched. The
question rides the run rung \u2014 \`--allow-runs\` covers it, and a standing
\`run/<project>\` grant answers it.

\`pewt agent\` is a pipe, not a conversation: one ACP message per line in on
stdin, the agent's own messages out on stdout. Whatever is on the other end
is the ACP client \u2014 a tab is the one Pewter ships toward.

\`pewt tabs\`, \`pewt files\`, \`open\` and \`fling\` are answered by the page rather
than by the host: a tab is not on disk anywhere and a flung copy is in the
browser's storage, so the host forwards these down the session the shell holds.
They need a page open, which is what exit 4 says.

open, fling:
  <path> is relative to the pewter, and inside it. The page reads it through
  the grant it already holds, so nothing rides the wire and there is no size
  limit \u2014 the browser's storage quota is the only one. \`open\` is a window on
  the file and follows it; \`fling\` is a copy the page owns and keeps working
  when the file, the host and the grant are all gone.

\`pewt check\` compiles \`extensions/\` with this pewter's own TypeScript \u2014 the
same compiler your editor and your CI use, out of your own node_modules. It is
the one command with no host in it: the moment you want a typecheck is while
you are writing, which is not necessarily a moment with a host up, so it reads
the disk here and answers here. That is also why there is no \`pewt.check()\`
for an extension to call.

It starts a process and does not ask, unlike \`run\`, \`shell\` and \`agent\`. A
typechecker reads your extensions and never runs them, which is what \`ext
bundle\` already does.

Exit codes: 0 done \xB7 1 refused \xB7 2 usage \xB7 3 no host is running \xB7 4 no page is
open. The last two are separate because they are separate things to do: start
the host, or open the shell and hand it this folder.
\`pewt check\` uses the first three differently: 0 is clean, 1 is errors found,
and 2 is could not check at all \u2014 no compiler, no tsconfig \u2014 because a git
hook wants "your code is wrong" and "this pewter is not set up" to be two
things.
\`pewt run\` exits with the script's own code instead, the way \`npm run\` does \u2014
so a script that exits 3 and a pewter with no host look alike, and the message
on stderr is what tells them apart.`;
function parseArgs(argv) {
  let dir = null;
  let url = null;
  let repo = null;
  let json = false;
  let open = true;
  let dryRun = false;
  let allowRuns = false;
  let allowShells = false;
  let allowAgents = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h" || a === "help")
      return { kind: "help", text: USAGE };
    else if (a === "--json")
      json = true;
    else if (a === "--no-open")
      open = false;
    else if (a === "--dry-run")
      dryRun = true;
    else if (a === "--allow-runs")
      allowRuns = true;
    else if (a === "--allow-shells")
      allowShells = true;
    else if (a === "--allow-agents")
      allowAgents = true;
    else if (a === "--dir" || a === "--url" || a === "--repo") {
      const value = argv[++i];
      if (!value)
        return { kind: "error", message: `${a} needs a value` };
      if (a === "--dir")
        dir = value;
      else if (a === "--url")
        url = value;
      else
        repo = value;
    } else if (a.startsWith("--dir="))
      dir = a.slice("--dir=".length);
    else if (a.startsWith("--url="))
      url = a.slice("--url=".length);
    else if (a.startsWith("--repo="))
      repo = a.slice("--repo=".length);
    else if (a.startsWith("-"))
      return { kind: "error", message: `unknown flag ${a}` };
    else
      rest.push(a);
  }
  if (rest.length === 0)
    return { kind: "help", text: USAGE };
  if (rest[0] === "serve") {
    if (rest.length > 1)
      return { kind: "error", message: `serve takes no arguments (got ${rest.slice(1).join(" ")})` };
    return { kind: "serve", dir, url, open, allowRuns, allowShells, allowAgents };
  }
  if (rest[0] === "check") {
    if (rest.length > 1)
      return { kind: "error", message: `check takes no arguments (got ${rest.slice(1).join(" ")}) \u2014 it compiles all of extensions/` };
    return { kind: "check", dir, json };
  }
  const found = byArgv(rest);
  if (!found)
    return { kind: "error", message: `unknown command ${JSON.stringify(rest.join(" "))}` };
  try {
    if ("process" in found) {
      if (repo !== null && !found.process.repo)
        return { kind: "error", message: `${found.process.cli.join(" ")} takes no --repo` };
      return {
        kind: "process",
        dir,
        json,
        dryRun,
        method: found.process.method,
        // Through `parse`, not around it: what the command line typed and
        // what an extension passed become one spec in one place, and a
        // front end that skipped it would be inventing a second wire format.
        spec: found.process.parse({ ...found.process.fromArgv(found.rest), ...repo !== null ? { repo } : {} })
      };
    }
    if (repo !== null)
      return { kind: "error", message: `${found.op.cli.join(" ")} takes no --repo` };
    if (dryRun)
      return { kind: "error", message: `${found.op.cli.join(" ")} starts nothing, so --dry-run has nothing to describe` };
    return { kind: "op", dir, json, method: found.op.method, params: found.op.fromArgv(found.rest) };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

// ../common/dist/frames.js
var HEADER_SIZE = 5;
var FrameType = {
  DATA: 1,
  // raw stdio/pty bytes
  // 2–4 reserved: early-v0 PING/PONG/CTL, retired when the control plane
  // moved to JSON-RPC (spec/DECISIONS.md D10). Never reuse.
  RPC: 5
  // one JSON-RPC 2.0 message (rpc.ts)
};
var frameTypeNames = new Map(Object.entries(FrameType).map(([k, v]) => [v, k]));
function frameTypeName(type) {
  return frameTypeNames.get(type) ?? `0x${type.toString(16)}`;
}
function encodeFrame(type, payload) {
  const buf = new Uint8Array(HEADER_SIZE + payload.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, payload.length, true);
  buf[4] = type;
  buf.set(payload, HEADER_SIZE);
  return buf;
}
function decodeJson(payload) {
  return JSON.parse(new TextDecoder().decode(payload));
}
function parseFrames(bytes) {
  const frames = [];
  let off = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off + HEADER_SIZE <= bytes.length) {
    const len = dv.getUint32(off, true);
    if (off + HEADER_SIZE + len > bytes.length)
      break;
    frames.push({
      type: bytes[off + 4],
      payload: bytes.subarray(off + HEADER_SIZE, off + HEADER_SIZE + len)
    });
    off += HEADER_SIZE + len;
  }
  return { frames, consumed: off };
}
function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function now() {
  return performance.timeOrigin + performance.now();
}
function chunkName(seq) {
  return String(seq).padStart(8, "0") + ".f";
}
var CHUNK_RE = /^(\d{8})\.f$/;
function segName(gen) {
  return `out.${String(gen).padStart(8, "0")}.log`;
}
var OUT_LOG_RE = /^out\.(\d{8})\.log$/;
var DIR_CHUNK_RE = /^(\d{8})-([A-Za-z0-9_-]+)$/;
function dirChunkName(seq, bytes) {
  return String(seq).padStart(8, "0") + "-" + b64urlEncode(bytes);
}
function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes)
    bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function b64urlDecode(str2) {
  const bin = atob(str2.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
var DIR_CHUNK_MAX_BYTES = 180;

// ../common/dist/rpc.js
var RpcErrors = {
  // JSON-RPC 2.0 predefined
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // fsio application errors (spec/PROTOCOL.md "Control plane")
  SHELL_NOT_ALLOWED: 1001,
  SPAWN_FAILED: 1002,
  UNKNOWN_KIND: 1003,
  /** host spawn policy (onSpawnRequest hook) refused the session (D12). */
  SPAWN_DENIED: 1004,
  /** attach refused: session exited or not attachable (D18). */
  ATTACH_FAILED: 1005,
  /** hub deployment (D22): `workspace` names no entry this host can
   *  resolve, or none this client may see. Reserved here so the numbers
   *  stay stable — no shipped host emits 1006/1007 yet (#71). */
  UNKNOWN_WORKSPACE: 1006,
  /** hub deployment (D23): no valid grant covers the request. Absent,
   *  expired, invalid, and revoked are deliberately one code — the
   *  client's next move (ask for consent) is the same for all four. */
  GRANT_REQUIRED: 1007
};
var SPAWN_REQUEST_ID = 0;
function rpcRequest(id, method, params) {
  const msg = { jsonrpc: "2.0", id, method };
  if (params !== void 0)
    msg.params = params;
  return msg;
}
function rpcNotification(method, params) {
  const msg = { jsonrpc: "2.0", method };
  if (params !== void 0)
    msg.params = params;
  return msg;
}
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== void 0)
    error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}
var RpcError = class extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
};
var RpcEndpoint = class {
  _send;
  _nextId = 1;
  _pending = /* @__PURE__ */ new Map();
  constructor(send) {
    this._send = send;
  }
  /** Send a request. Resolves {result, rx}; rejects with RpcError on an
   *  error response, or Error on timeout. */
  request(method, params, { timeoutMs = 0 } = {}) {
    const id = this._nextId++;
    const promise = this.expect(id, { timeoutMs });
    try {
      this._send(rpcRequest(id, method, params));
    } catch (e) {
      this._settle(id)?.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return promise;
  }
  /** Await a response for a request sent out of band (e.g. the spawn
   *  request that rides spawn.json rather than a frame). */
  expect(id, { timeoutMs = 0 } = {}) {
    return new Promise((resolve2, reject) => {
      const entry = { resolve: resolve2, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this._settle(id)?.reject(new Error(`rpc timeout: no response for id ${id} in ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this._pending.set(id, entry);
    });
  }
  notify(method, params) {
    this._send(rpcNotification(method, params));
  }
  /** Feed one incoming JSON-RPC message. Returns true if it was a response
   *  and has been consumed (matched or ignored); false if it is a request
   *  or notification the caller should dispatch. */
  handleMessage(msg, rx = Date.now()) {
    if (!msg || typeof msg !== "object")
      return false;
    const m = msg;
    if (m.method !== void 0)
      return false;
    if (m.id === void 0 || m.id === null)
      return true;
    const entry = this._settle(m.id);
    if (!entry)
      return true;
    if (m.error)
      entry.reject(new RpcError(m.error.code, m.error.message, m.error.data));
    else
      entry.resolve({ result: m.result, rx });
    return true;
  }
  /** Reject everything in flight (endpoint shutting down). */
  failAll(err = new Error("rpc endpoint closed")) {
    for (const id of [...this._pending.keys()])
      this._settle(id)?.reject(err);
  }
  _settle(id) {
    const entry = this._pending.get(id);
    if (!entry)
      return null;
    this._pending.delete(id);
    if (entry.timer)
      clearTimeout(entry.timer);
    return entry;
  }
};

// ../common/dist/protocol.js
var PROTOCOL_VERSION = 0;
var CAPABILITIES = {
  /** `kind: "shell"` may be requested (the D12 policy still judges each). */
  SHELL: "shell",
  /** shell sessions get a real pty rather than the pipe fallback (D14). */
  PTY: "pty",
  /** `attach` is served: takeover with writer epochs and replay (D18). */
  ATTACH: "attach",
  /** `workspace` names resolve to roots this host serves (D22). */
  WORKSPACES: "workspaces"
};

// ../client/dist/index.js
var hasObserver = "FileSystemObserver" in globalThis;
var COMMIT_RETRY_MS = [10, 50, 250, 1e3];
var DIR_LANE_SLOW_MS = 25;
var DIR_LANE_SLOW_STREAK = 3;
var DIR_LANE_REPROBE_MS = 6e4;
var DIR_LANE_BROKEN_STRIKES = 2;
var LANE_EWMA_ALPHA = 0.3;
var OBSERVE_SETTLE_MS = 2e3;
var ewma = (prev, sample) => prev === void 0 ? sample : prev * (1 - LANE_EWMA_ALPHA) + sample * LANE_EWMA_ALPHA;
var errName = (e) => e instanceof DOMException || e instanceof Error ? e.name : "Error";
var errMsg = (e) => e instanceof Error ? e.message : String(e);
async function op(label, fn) {
  try {
    return await fn();
  } catch (e) {
    const err = new Error(`${label}: ${errName(e)}: ${errMsg(e)}`);
    err.cause = e;
    throw err;
  }
}
var FsioClient = class {
  root;
  fsioDir;
  sessionsDir;
  /** last-read service directory, refreshed when `servicesRev` moves (D24). */
  servicesDoc = null;
  constructor(rootHandle) {
    this.root = rootHandle;
  }
  async connect() {
    this.fsioDir = await op("opening .fsio/", () => this.root.getDirectoryHandle(".fsio", { create: true }));
    this.sessionsDir = await op("opening .fsio/sessions/", () => this.fsioDir.getDirectoryHandle("sessions", { create: true }));
    return this.hostInfo();
  }
  /** Reads host.json; returns {alive, info, ageMs} */
  async hostInfo() {
    try {
      const fh = await this.fsioDir.getFileHandle("host.json");
      const f = await fh.getFile();
      const info = JSON.parse(await f.text());
      const ageMs = Date.now() - f.lastModified;
      return { alive: ageMs < 6e3, ageMs, info };
    } catch {
      return { alive: false, ageMs: Infinity, info: null };
    }
  }
  /** Read the service directory (D24): what this host can do, which kinds
   *  it serves, and the workspace **names** it advertises (never paths).
   *
   *  The doorbell is `host.json`'s `servicesRev` (D3's hot-pointer/cold-state
   *  split): a client already statting the heartbeat passes that revision
   *  here and gets its cached copy back untouched unless the number moved.
   *  Feature-detect on `capabilities` names, not on `protocol` ranges, and
   *  treat an unknown name as "not supported", never as an error (D25). */
  async services(rev) {
    if (rev !== void 0 && this.servicesDoc && this.servicesDoc.rev === rev)
      return this.servicesDoc;
    try {
      const fh = await this.fsioDir.getFileHandle("services.json");
      const doc = JSON.parse(await (await fh.getFile()).text());
      if (!doc || typeof doc !== "object")
        return null;
      this.servicesDoc = doc;
      return doc;
    } catch {
      return null;
    }
  }
  /** Sugar for the D25 handshake: is this capability name advertised? */
  async hasCapability(name, rev) {
    const doc = await this.services(rev);
    return !!doc && Array.isArray(doc.capabilities) && doc.capabilities.includes(name);
  }
  /** Synchronous by design (D11): the caller gets a listener-attachment
   *  window before any event can possibly fire. All async init failures
   *  (folder creation, spawn.json commit) reject `session.ready`. */
  createSession(spec, opts = {}) {
    if (!this.sessionsDir)
      throw new Error("createSession before connect()");
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new FsioSession(id, this.sessionsDir, spec, opts);
  }
  /** Enumerate sessions in the shared dir (D18 discovery) — read-only, the
   *  reattach picker's data source. `status.detached` marks orphans;
   *  `status.writer` names the current uplink owner. */
  async listSessions() {
    if (!this.sessionsDir)
      throw new Error("listSessions before connect()");
    const out = [];
    for await (const name of this.sessionsDir.keys()) {
      if (!name.startsWith("s-"))
        continue;
      try {
        const dir = await this.sessionsDir.getDirectoryHandle(name);
        const readJson2 = async (f) => JSON.parse(await (await (await dir.getFileHandle(f)).getFile()).text());
        const entry = { id: name, kind: null, status: null };
        try {
          const spawn5 = await readJson2("spawn.json");
          const p = spawn5.params ?? spawn5;
          entry.kind = p.kind ?? "echo";
          entry.client = p.client;
          entry.origin = p.origin;
        } catch {
        }
        try {
          entry.status = await readJson2("status.json");
        } catch {
        }
        out.push(entry);
      } catch {
      }
    }
    return out;
  }
  /** Attach to an existing session (D18). Semantics: TAKEOVER — the grant
   *  bumps the writer epoch, moves the uplink to `in.<epoch>/`, and fences
   *  the previous client (it observes `writer` in status.json and stops
   *  sending). `replay: true` re-emits the head segment's DATA frames
   *  (scrollback) before live output. `ready` resolves with the
   *  AttachResult (kind, pid, epoch, …) or rejects with a coded RpcError
   *  (1005 exited, 1001/1004 policy denial). */
  attachSession(sessionId, opts = {}) {
    if (!this.sessionsDir)
      throw new Error("attachSession before connect()");
    return new FsioSession(sessionId, this.sessionsDir, null, opts, { replay: opts.replay ?? false, client: opts.client });
  }
};
var FsioSession = class {
  id;
  pollMs;
  uplink;
  safetyMs;
  heartbeatMs;
  /** Resolves with the spawn result; rejects with RpcError on spawn failure
   *  (and with the underlying error on init failure). */
  ready;
  stats = {
    chunksWritten: 0,
    dirChunks: 0,
    fileChunks: 0,
    bytesIn: 0,
    bytesOut: 0,
    wakeups: 0
  };
  /** Effective notifier mode; may downgrade at init (observer refusal, D7). */
  get mode() {
    return this.#mode;
  }
  get status() {
    return this.#status;
  }
  get closed() {
    return this.#closed;
  }
  /** Writer epoch this client owns (D18): 0 = spawning client; attachers
   *  get theirs from the grant. A higher epoch in status.json means this
   *  client has been superseded. */
  get epoch() {
    return this.#epoch;
  }
  #mode;
  #status = null;
  #dir;
  #inDir;
  #initDone;
  /** gates #pump: init for spawned sessions; the full grant + setup for
   *  attached ones (no uplink lane exists before the epoch is known). */
  #uplinkReady;
  #epoch = 0;
  #attach = null;
  /** the grant expectation for the aid whose bootstrap commit actually
   *  landed (#116) — set by #initAttach, awaited by `ready`. */
  #granted = null;
  /** non-null while attaching: live frames buffered until grant + replay
   *  have run, so replayed scrollback precedes them. */
  #hold = null;
  #listeners = /* @__PURE__ */ new Map();
  #gen = 0;
  // current out segment being read
  #offset = 0;
  // consumed bytes within current segment
  #cumConsumed = 0;
  // cumulative bytes consumed across segments
  #lastAckTotal = 0;
  #lastAckAt = 0;
  #outSeq = 1;
  // next chunk number to write
  // Dirname-lane health (#4; auto mode only — forced lanes are for labs).
  #dirLane = "on";
  #dirLaneSlowMs;
  #dirLaneReprobeMs;
  #dirLaneSince = 0;
  // when "slow" latched; gates the re-probe
  #dirSlowStreak = 0;
  #dirLaneStrikes = 0;
  #queue = [];
  // encoded frames awaiting commit
  #pumping = false;
  #reading = false;
  #readAgain = false;
  #closed = false;
  #pumpError = null;
  // first async send failure; surfaced via "error" + next send()
  // Control plane: JSON-RPC over RPC frames (spec D10). One endpoint per
  // session owns id correlation; responses are consumed in #drainSegment.
  #rpc;
  #observeSettleMs;
  #observer = null;
  #pollTimer;
  #hotTimer = null;
  #safetyTimer;
  #heartbeatTimer;
  #lastActivity = 0;
  #wakeFn;
  constructor(id, sessionsDir, spec, opts = {}, attach) {
    const { mode = "auto", pollMs = 15, uplink = "auto", safetyMs = 500, heartbeatMs = 2e4, uplinkLane = {}, observeSettleMs = OBSERVE_SETTLE_MS } = opts;
    this.#dirLaneSlowMs = uplinkLane.slowMs ?? DIR_LANE_SLOW_MS;
    this.#dirLaneReprobeMs = uplinkLane.reprobeMs ?? DIR_LANE_REPROBE_MS;
    this.#observeSettleMs = observeSettleMs;
    const webOrigin = globalThis.location?.origin;
    if (spec && typeof webOrigin === "string")
      spec = { ...spec, origin: webOrigin };
    this.id = id;
    this.pollMs = pollMs;
    this.safetyMs = safetyMs;
    this.heartbeatMs = heartbeatMs;
    this.uplink = uplink;
    if (uplink === "auto")
      this.stats.dirLane = "on";
    this.#mode = mode === "auto" ? hasObserver ? "adaptive" : "poll" : mode;
    this.#rpc = new RpcEndpoint((msg) => this.sendJson(FrameType.RPC, msg));
    if (attach) {
      const params = { aid: "" };
      if (attach.client !== void 0)
        params.client = attach.client;
      if (typeof webOrigin === "string")
        params.origin = webOrigin;
      this.#attach = { replay: attach.replay, aid: "", params, replayTo: null };
      this.#initDone = this.#initAttach(sessionsDir);
      this.ready = this.#initDone.then(() => this.#granted).then(async ({ result }) => {
        await this.#completeAttach(result);
        return result;
      });
      this.#uplinkReady = this.ready.then(() => {
      });
      this.#uplinkReady.catch(() => {
      });
    } else {
      const spawned = this.#rpc.expect(SPAWN_REQUEST_ID);
      spawned.catch(() => {
      });
      this.#initDone = this.#init(sessionsDir, spec);
      this.ready = this.#initDone.then(() => spawned).then(({ result }) => result);
      this.#uplinkReady = this.#initDone;
    }
    this.ready.catch(() => {
    });
  }
  /** Subscribe; returns the unsubscribe function (disposal, D11). All
   *  listeners are dropped on close(). */
  on(type, listener) {
    let set = this.#listeners.get(type);
    if (!set)
      this.#listeners.set(type, set = /* @__PURE__ */ new Set());
    set.add(listener);
    return () => set.delete(listener);
  }
  #emit(type, ...args) {
    const set = this.#listeners.get(type);
    if (!set?.size) {
      if (type === "error")
        setTimeout(() => {
          throw args[0];
        }, 0);
      return;
    }
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (type === "error")
          setTimeout(() => {
            throw err;
          }, 0);
        else
          this.#emit("error", err);
      }
    }
  }
  async #init(sessionsDir, spec) {
    this.#dir = await op(`creating session folder ${this.id}`, () => sessionsDir.getDirectoryHandle(this.id, { create: true }));
    this.#inDir = await op(`creating session ${this.id}/in/`, () => this.#dir.getDirectoryHandle("in", { create: true }));
    const bytes = new TextEncoder().encode(JSON.stringify(rpcRequest(SPAWN_REQUEST_ID, "spawn", spec)));
    await this.#commitBootstrap("spawn.json", () => this.#writeFile("spawn.json", bytes));
    await this.#startNotifier();
  }
  /** Bootstrap commits are file-lane writes on the critical path with no
   *  pump behind them, and Chrome aborts `close()` mid-stream often enough
   *  to have its own finding (#37: `AbortError: Aborted due to security
   *  policy`). spec/PROTOCOL.md's "retry with bounded backoff" rule was
   *  written for chunks and left these exposed — one abort killed a reattach
   *  to a live session in the field (#115/#116).
   *
   *  `attempt` re-runs the whole commit, so callers that must vary something
   *  per try (attach's aid) do it inside the closure. */
  async #commitBootstrap(what, attempt) {
    for (let i = 0; ; i++) {
      try {
        await attempt();
        return;
      } catch (e) {
        if (i >= COMMIT_RETRY_MS.length || this.#closed)
          throw e;
        this.stats.commitRetries = (this.stats.commitRetries ?? 0) + 1;
        this.#emit("note", `retrying ${what} after a transient commit failure (${e instanceof Error ? e.message : String(e)})`);
        await new Promise((r) => setTimeout(r, COMMIT_RETRY_MS[i]));
      }
    }
  }
  async #initAttach(sessionsDir) {
    const a = this.#attach;
    this.#dir = await op(`opening session ${this.id}`, () => sessionsDir.getDirectoryHandle(this.id));
    try {
      const fh = await this.#dir.getFileHandle("out.sig");
      const sig = JSON.parse(await (await fh.getFile()).text());
      this.#gen = sig.gen;
      this.#offset = sig.size;
      this.#cumConsumed = sig.total;
      this.#lastAckTotal = sig.total;
      if (a.replay)
        a.replayTo = { gen: sig.gen, end: sig.size };
    } catch {
    }
    this.#hold = [];
    await this.#commitBootstrap("the attach request", async () => {
      a.aid = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      a.params.aid = a.aid;
      const granted = this.#rpc.expect(`attach:${a.aid}`);
      granted.catch(() => {
      });
      this.#granted = granted;
      await this.#writeFile(`attach.${a.aid}.json`, new TextEncoder().encode(JSON.stringify(rpcRequest(`attach:${a.aid}`, "attach", a.params))));
    });
    await this.#startNotifier();
  }
  async #completeAttach(result) {
    this.#epoch = result.epoch;
    this.#inDir = await op(`creating session ${this.id}/in.${result.epoch}/`, () => this.#dir.getDirectoryHandle(`in.${result.epoch}`, { create: true }));
    const a = this.#attach;
    if (a.replayTo) {
      this.#emit("replay", "start", a.replayTo.gen);
      await this.#replayHead(a.replayTo.gen, a.replayTo.end);
      this.#emit("replay", "end", a.replayTo.gen);
    }
    const held = this.#hold ?? [];
    this.#hold = null;
    for (const [f, at] of held) {
      this.#emit("frame", f, at);
      if (f.type === FrameType.DATA)
        this.#emit("data", f.payload);
    }
    if (this.#status)
      this.#maybeFence(this.#status);
  }
  // Scrollback replay (D18): re-read the head segment [0, end) and emit its
  // DATA frames. Client-local — the host is not involved. RPC frames are
  // NEVER replayed: they are the previous writer's control traffic, and
  // its response ids could collide with this endpoint's live requests.
  async #replayHead(gen, end) {
    if (end <= 0)
      return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fh = await this.#dir.getFileHandle(`out.${String(gen).padStart(8, "0")}.log`);
        const bytes = new Uint8Array(await (await fh.getFile()).slice(0).arrayBuffer()).subarray(0, end);
        const { frames } = parseFrames(bytes);
        const at = now();
        for (const f of frames) {
          if (f.type !== FrameType.DATA)
            continue;
          this.#emit("frame", f, at);
          this.#emit("data", f.payload);
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    this.#emit("note", "scrollback replay unavailable (head segment unreadable)");
  }
  async #writeFile(name, bytes, dir = this.#dir) {
    return op(`committing ${name}`, async () => {
      const t0 = performance.now();
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes);
      await w.close();
      this.stats.fileCommitMs = ewma(this.stats.fileCommitMs, performance.now() - t0);
    });
  }
  // ---------------- outgoing (client -> host)
  /** Enqueue a frame; frames queued while a commit is in flight are batched
   *  into a single chunk file. Commits are strictly serialized. */
  send(type, payload) {
    this.#enqueue(type, payload);
    this.#markActive();
  }
  #enqueue(type, payload) {
    if (this.#pumpError)
      throw this.#pumpError;
    this.#queue.push(encodeFrame(type, payload));
    void this.#pump();
  }
  sendJson(type, obj) {
    this.send(type, new TextEncoder().encode(JSON.stringify(obj)));
  }
  sendData(text) {
    this.send(FrameType.DATA, new TextEncoder().encode(text));
  }
  /** JSON-RPC request to the host; resolves {result, rx}. */
  request(method, params, opts) {
    return this.#rpc.request(method, params, opts);
  }
  /** JSON-RPC notification (fire-and-forget: resize, ack, close…). */
  notify(method, params) {
    this.#rpc.notify(method, params);
  }
  /** Uncommitted uplink chunks in this writer's in-dir (labs; #4). */
  async uplinkBacklog() {
    await this.#uplinkReady;
    let n = 0;
    for await (const _ of this.#inDir.keys())
      n++;
    return n;
  }
  async #pump() {
    if (this.#pumping)
      return;
    this.#pumping = true;
    try {
      try {
        await this.#uplinkReady;
      } catch (e) {
        this.#pumpError = e instanceof Error ? e : new Error(String(e));
        this.#queue.length = 0;
        return;
      }
      while (this.#queue.length > 0 && !this.#closed && !this.#pumpError) {
        const batch = concatBytes(this.#queue.splice(0));
        await this.#commitChunk(batch);
        this.stats.chunksWritten++;
        this.stats.bytesOut += batch.length;
      }
    } catch (e) {
      this.#pumpError = e instanceof Error ? e : new Error(String(e));
      this.#emit("error", this.#pumpError);
    } finally {
      this.#pumping = false;
    }
  }
  // Commit `batch` as the next chunk, retrying transient failures with
  // bounded backoff (#37; spec Uplink). A failed commit must not abandon
  // its sequence number: the host consumes in/ strictly in order, so a gap
  // wedges the uplink for the rest of the session — the observed CfT abort
  // ("AbortError: Aborted due to security policy") cost the whole bench,
  // not one message. Retrying the SAME seq is idempotent:
  //   - commit truly failed (common case): nothing became visible — the
  //     swap file was never renamed in; dir creation is create-or-open;
  //   - commit landed but still threw: identical bytes re-land under the
  //     same name (host re-reads torn snapshots, invariant 3/F11), or, if
  //     already consumed, the re-created chunk sits below the host's
  //     consumption point, inert until session cleanup (D6).
  async #commitChunk(batch) {
    const seq = this.#outSeq;
    let dirLane = this.uplink === "dirname" || this.uplink === "auto" && batch.length <= DIR_CHUNK_MAX_BYTES && this.#dirLaneEligible();
    let fellBack = false;
    for (let attempt = 0; ; attempt++) {
      try {
        if (dirLane) {
          const name = dirChunkName(seq, batch);
          const t0 = performance.now();
          await op(`committing ${name.slice(0, 12)}\u2026/`, () => this.#inDir.getDirectoryHandle(name, { create: true }));
          this.stats.dirChunks++;
          if (this.uplink === "auto")
            this.#dirLaneSample(performance.now() - t0);
        } else {
          await this.#writeFile(chunkName(seq), batch, this.#inDir);
          this.stats.fileChunks++;
          if (fellBack)
            this.#dirLaneStrike();
        }
        this.#outSeq = seq + 1;
        return;
      } catch (e) {
        if (dirLane && this.uplink === "auto") {
          dirLane = false;
          fellBack = true;
          this.stats.laneFallbacks = (this.stats.laneFallbacks ?? 0) + 1;
          this.#emit("note", `chunk ${seq} dirname commit failed (${errMsg(e)}) \u2014 falling back to a file chunk`);
          continue;
        }
        if (attempt >= COMMIT_RETRY_MS.length || this.#closed)
          throw e;
        this.stats.commitRetries = (this.stats.commitRetries ?? 0) + 1;
        this.#emit("note", `chunk ${seq} commit failed (${errMsg(e)}) \u2014 retrying in ${COMMIT_RETRY_MS[attempt]}ms`);
        await new Promise((r) => setTimeout(r, COMMIT_RETRY_MS[attempt]));
      }
    }
  }
  // ---- dirname-lane health (#4; auto mode only)
  /** May this small batch ride the dirname lane? "slow" earns one real
   *  batch as a re-probe once per reprobe window (the periodic re-probe:
   *  no synthetic traffic, the next chunk is the experiment). */
  #dirLaneEligible() {
    if (this.#dirLane === "on")
      return true;
    if (this.#dirLane === "broken")
      return false;
    if (Date.now() - this.#dirLaneSince >= this.#dirLaneReprobeMs) {
      this.#dirLaneSince = Date.now();
      return true;
    }
    return false;
  }
  #dirLaneStrike() {
    if (this.#dirLane === "broken")
      return;
    if (++this.#dirLaneStrikes >= DIR_LANE_BROKEN_STRIKES) {
      this.#dirLane = "broken";
      this.stats.dirLane = "broken";
      this.#emit("note", `dirname lane disabled for this session (${this.#dirLaneStrikes} commits failed where file chunks worked)`);
    }
  }
  #dirLaneSample(ms) {
    this.stats.dirCommitMs = ewma(this.stats.dirCommitMs, ms);
    this.stats.dirLane = this.#dirLane;
    const vis = globalThis.document?.visibilityState;
    if (this.#dirLane === "broken" || vis === "hidden")
      return;
    const file = this.stats.fileCommitMs;
    const slow = ms > this.#dirLaneSlowMs && (file === void 0 || ms > file * 0.75);
    if (this.#dirLane === "on") {
      this.#dirSlowStreak = slow ? this.#dirSlowStreak + 1 : 0;
      if (this.#dirSlowStreak >= DIR_LANE_SLOW_STREAK) {
        this.#dirLane = "slow";
        this.stats.dirLane = "slow";
        this.#dirLaneSince = Date.now();
        this.#emit("note", `dirname lane slow (${this.#dirSlowStreak}\xD7 > ${this.#dirLaneSlowMs}ms, EWMA ${this.stats.dirCommitMs.toFixed(1)}ms) \u2014 preferring file chunks, will re-probe`);
      }
    } else if (!slow) {
      this.#dirLane = "on";
      this.stats.dirLane = "on";
      this.stats.dirCommitMs = ms;
      this.#dirSlowStreak = 0;
      this.#emit("note", `dirname lane recovered (${ms.toFixed(1)}ms) \u2014 fast lane restored`);
    } else {
      this.#dirLaneSince = Date.now();
    }
  }
  // ---------------- incoming (host -> client)
  async #startNotifier() {
    const wake = () => {
      this.stats.wakeups++;
      void this.#wake();
    };
    this.#wakeFn = wake;
    if (this.#mode === "observer" || this.#mode === "hybrid" || this.#mode === "adaptive") {
      this.#attachObserver(wake);
    }
    if (this.#mode === "poll" || this.#mode === "hybrid") {
      this.#pollTimer = setInterval(wake, this.pollMs);
    }
    if (this.#mode === "adaptive")
      this.#markActive();
    if (this.safetyMs > 0)
      this.#safetyTimer = setInterval(wake, this.safetyMs);
    if (this.heartbeatMs > 0) {
      this.#heartbeatTimer = setInterval(() => {
        try {
          this.#enqueue(FrameType.RPC, new TextEncoder().encode(JSON.stringify(rpcNotification("heartbeat"))));
        } catch {
        }
      }, this.heartbeatMs);
    }
  }
  /** Observer startup, concurrent with session traffic. Three outcomes:
   *  settle (adopt), reject (downgrade, D7/F9), or stall past
   *  observeSettleMs (downgrade, F19 — the straggler is disconnected if
   *  it ever settles; by then the poll owns wakes). */
  #attachObserver(wake) {
    let obs;
    try {
      obs = new FileSystemObserver(wake);
    } catch (e) {
      this.#observerFailed(wake, `FileSystemObserver refused to start (${errName(e)}: ${errMsg(e)})`);
      return;
    }
    const started = obs.observe(this.#dir, { recursive: true });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled)
        return;
      settled = true;
      started.then(() => obs.disconnect()).catch(() => {
      });
      this.#observerFailed(wake, `FileSystemObserver.observe() did not settle within ${this.#observeSettleMs}ms (F19)`);
    }, this.#observeSettleMs);
    started.then(() => {
      clearTimeout(timer);
      if (settled)
        return;
      settled = true;
      if (this.#closed)
        return obs.disconnect();
      this.#observer = obs;
    }, (e) => {
      clearTimeout(timer);
      if (settled)
        return;
      settled = true;
      this.#observerFailed(wake, `FileSystemObserver refused to start (${errName(e)}: ${errMsg(e)})`);
    });
  }
  #observerFailed(wake, why) {
    if (this.#closed)
      return;
    this.#emit("note", `${why} \u2014 falling back to polling`);
    this.#mode = "poll";
    if (!this.#pollTimer)
      this.#pollTimer = setInterval(wake, this.pollMs);
  }
  // Adaptive mode: hot poll exists only while traffic is flowing. The
  // observer (300ms cadence) and safety poll cover the idle case; the first
  // event after idle re-arms the hot poll.
  #markActive() {
    this.#lastActivity = Date.now();
    if (this.#mode !== "adaptive" || this.#hotTimer || this.#closed)
      return;
    this.#hotTimer = setInterval(() => {
      if (Date.now() - this.#lastActivity > 2e3) {
        clearInterval(this.#hotTimer);
        this.#hotTimer = null;
        return;
      }
      this.#wakeFn();
    }, this.pollMs);
  }
  async #wake() {
    if (this.#reading) {
      this.#readAgain = true;
      return;
    }
    this.#reading = true;
    try {
      do {
        this.#readAgain = false;
        await this.#drainOutLog();
        await this.#checkStatus();
      } while (this.#readAgain);
    } catch (e) {
      this.#emit("note", `reader hiccup (retrying): ${errMsg(e)}`);
    } finally {
      this.#reading = false;
    }
  }
  // The out stream is segmented (out.<gen>.log, rotated by the host at
  // ~8 MB, always on frame boundaries). out.sig maps the stream:
  // {gen, size, prevFinal, total}. We drain the current segment, hop to the
  // next when the previous one is fully consumed, and ack cumulative
  // consumption so the host can pause the pty (flow control) and delete
  // consumed segments.
  async #drainOutLog() {
    let sig;
    try {
      const fh = await this.#dir.getFileHandle("out.sig");
      sig = JSON.parse(await (await fh.getFile()).text());
    } catch {
      return;
    }
    if (sig.gen > this.#gen + 1) {
      this.#emit("note", `fell ${sig.gen - this.#gen} segments behind; skipping ahead (output lost)`);
      this.#gen = sig.gen;
      this.#offset = 0;
    }
    while (true) {
      await this.#drainSegment();
      const behind = this.#gen < sig.gen;
      if (behind && this.#offset >= sig.prevFinal) {
        this.#gen++;
        this.#offset = 0;
        continue;
      }
      break;
    }
    this.#maybeAck();
  }
  async #drainSegment() {
    let bytes;
    try {
      const fh = await this.#dir.getFileHandle(`out.${String(this.#gen).padStart(8, "0")}.log`);
      const file = await fh.getFile();
      if (file.size <= this.#offset)
        return;
      bytes = new Uint8Array(await file.slice(this.#offset).arrayBuffer());
    } catch {
      this.stats.staleReads = (this.stats.staleReads ?? 0) + 1;
      return;
    }
    const { frames, consumed } = parseFrames(bytes);
    this.#offset += consumed;
    this.#cumConsumed += consumed;
    this.stats.bytesIn += consumed;
    if (consumed > 0)
      this.#markActive();
    const t3 = now();
    for (const f of frames) {
      if (f.type === FrameType.RPC) {
        let msg = null;
        try {
          msg = decodeJson(f.payload);
        } catch {
        }
        if (msg && this.#rpc.handleMessage(msg, t3))
          continue;
      }
      if (this.#hold) {
        this.#hold.push([f, t3]);
        continue;
      }
      this.#emit("frame", f, t3);
      if (f.type === FrameType.DATA)
        this.#emit("data", f.payload);
    }
  }
  // Ack at most every 250 ms (or every 256 KB under load). Acks ride the
  // dirname fast lane, so they cost ~3 ms, not ~70.
  #maybeAck() {
    if (this.#closed || this.#cumConsumed <= this.#lastAckTotal)
      return;
    const bytesSince = this.#cumConsumed - this.#lastAckTotal;
    if (bytesSince < 262144 && Date.now() - this.#lastAckAt < 250)
      return;
    this.#lastAckTotal = this.#cumConsumed;
    this.#lastAckAt = Date.now();
    try {
      this.notify("ack", { total: this.#cumConsumed });
    } catch {
    }
  }
  async #checkStatus() {
    try {
      const fh = await this.#dir.getFileHandle("status.json");
      const f = await fh.getFile();
      const status = JSON.parse(await f.text());
      if (JSON.stringify(status) !== JSON.stringify(this.#status)) {
        this.#status = status;
        this.#emit("status", status);
        if (this.#hold === null)
          this.#maybeFence(status);
      }
    } catch {
    }
  }
  /** Fence this writer if `status` names a higher epoch (D18): stop
   *  writing — one writer per file is the law (F8/D6) — but keep reading:
   *  the downlink is multi-reader. */
  #maybeFence(status) {
    if (status.writer && status.writer.epoch > this.#epoch && !this.#pumpError) {
      this.#pumpError = new Error(`superseded: another client attached (writer epoch ${status.writer.epoch})`);
      clearInterval(this.#heartbeatTimer);
      this.#queue.length = 0;
      this.#emit("note", `superseded by writer epoch ${status.writer.epoch}: sends now fail, reads continue`);
    }
  }
  /** Resolve when status matches `pred`, reject after timeoutMs. */
  waitForStatus(pred, timeoutMs = 4e3) {
    return new Promise((resolve2, reject) => {
      const check2 = (status) => {
        if (status && pred(status)) {
          cleanup();
          resolve2(status);
        }
      };
      const off = this.on("status", check2);
      const to = setTimeout(() => {
        cleanup();
        reject(new Error("status timeout"));
      }, timeoutMs);
      const cleanup = () => {
        off();
        clearTimeout(to);
      };
      check2(this.#status);
    });
  }
  // ---------------- lifecycle
  // Cleanup is the HOST's job: it deletes the session dir after the close
  // notification. (Lesson learned: a client-side recursive delete races
  // with host writes — doorbell renames, status.json — and dies with
  // InvalidModificationError. Two processes must never contend for the same
  // files; cleanup has one owner, and it's the side with POSIX semantics.)
  async close() {
    if (this.#closed)
      return;
    clearInterval(this.#heartbeatTimer);
    try {
      this.notify("close");
    } catch {
    }
    await this.#teardown();
  }
  /** Deliberate walk-away (D18): ask the host to mark the session detached
   *  NOW (no heartbeat-silence wait), then release local resources WITHOUT
   *  closing the session — the process keeps running for a later
   *  `attachSession()`. */
  async detach() {
    if (this.#closed)
      return;
    clearInterval(this.#heartbeatTimer);
    try {
      this.notify("detach");
    } catch {
    }
    await this.#teardown();
  }
  async #teardown() {
    if (this.#hold === null)
      while (this.#pumping)
        await new Promise((r) => setTimeout(r, 10));
    this.#closed = true;
    this.#rpc.failAll(new Error("session closed"));
    this.#observer?.disconnect();
    clearInterval(this.#pollTimer);
    if (this.#hotTimer)
      clearInterval(this.#hotTimer);
    clearInterval(this.#safetyTimer);
    this.#listeners.clear();
  }
};

// dist/call.js
var CallError = class extends Error {
  reason;
  code;
  hint;
  constructor(reason, message, code, hint) {
    super(message);
    this.reason = reason;
    this.code = code;
    this.hint = hint;
    this.name = "CallError";
  }
};
async function connect(dir) {
  const client = new FsioClient(dir);
  await dir.getDirectoryHandle(".fsio").catch(() => {
    throw new CallError("no_host", "no host is running in this pewter", void 0, "start one: npm start");
  });
  const host = await client.connect().catch((e) => {
    throw new CallError("transport", `cannot read the folder: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!host.alive) {
    throw new CallError("no_host", host.info ? `the host stopped (last heartbeat ${Math.round(host.ageMs / 1e3)}s ago)` : "no host is running in this pewter", void 0, "start one: npm start");
  }
  return client;
}
async function call(dir, method, params, opts = {}) {
  const client = await connect(dir);
  const session = client.createSession({ kind: "pewt", client: "pewt-cli" }, { pollMs: opts.pollMs ?? 15, heartbeatMs: 0 });
  try {
    await session.ready.catch((e) => {
      throw new CallError("transport", e instanceof Error ? e.message : String(e));
    });
    const { result } = await session.request(method, params, { timeoutMs: opts.timeoutMs ?? 3e4 });
    return result;
  } catch (e) {
    if (e instanceof CallError)
      throw e;
    if (e instanceof RpcError) {
      const data = e.data ?? {};
      const missing = data.code === "no_page" || data.code === "page_gone" || data.code === "timeout";
      throw new CallError(missing ? "no_page" : "refused", e.message, data.code, data.hint);
    }
    throw new CallError("timeout", e instanceof Error ? e.message : String(e));
  } finally {
    await session.close().catch(() => {
    });
  }
}

// dist/check.js
import { execFile as execFile2 } from "node:child_process";
import fs6 from "node:fs";
import path5 from "node:path";
var CheckError = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "CheckError";
  }
};
function compilerIn(p) {
  const dir = path5.join(p.root, "node_modules", "typescript");
  let pkg;
  try {
    pkg = JSON.parse(fs6.readFileSync(path5.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const bin = pkg.bin?.["tsc"];
  if (typeof bin !== "string")
    return null;
  const entry = path5.join(dir, bin);
  if (!fs6.existsSync(entry))
    return null;
  return { entry, version: typeof pkg.version === "string" ? pkg.version : "unknown" };
}
async function check(p) {
  const config = path5.join(p.root, "tsconfig.json");
  if (!fs6.existsSync(config)) {
    throw new CheckError("no_tsconfig", "this pewter has no tsconfig.json, so there is nothing describing how to compile it", "a scaffolded pewter has one covering extensions/ \u2014 `npm create pewt` writes it");
  }
  if (!fs6.existsSync(p.extensions)) {
    throw new CheckError("no_extensions", "this pewter has no extensions/ directory", "an extension is a directory under extensions/ with an index.html and a main.ts");
  }
  const compiler = compilerIn(p);
  if (!compiler) {
    throw new CheckError(
      "no_compiler",
      "this pewter has no typescript installed, so there is nothing to check with",
      // `npm create pewt` installs the compiler, so the folders that reach
      // this are the hand-made ones — the rig writes its own pewter, and so
      // does every test here. One sentence is the right size for that.
      "it runs your pewter's own compiler, the same one your editor uses: npm i -D typescript"
    );
  }
  const t0 = Date.now();
  const { code, out } = await run2(compiler.entry, p.root);
  const errors = parse(out);
  return { ok: code === 0, errors, version: compiler.version, ms: Date.now() - t0 };
}
function run2(entry, cwd) {
  return new Promise((resolve2, reject) => {
    execFile2(
      process.execPath,
      [entry, "--noEmit", "--pretty", "false"],
      // tsc writes one line per diagnostic and a project with a lot wrong
      // produces a lot of them; the default 1 MB would truncate mid-line and
      // this would report fewer errors than there are.
      { cwd, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err?.code;
        if (err && typeof code !== "number")
          return reject(new CheckError("compiler_failed", `the compiler did not run: ${err.message}`));
        resolve2({ code: typeof code === "number" ? code : 0, out: `${stdout}${stderr}` });
      }
    );
  });
}
function parse(out) {
  const placed = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  const bare = /^error (TS\d+): (.*)$/;
  const errors = [];
  for (const line of out.split("\n")) {
    const at = placed.exec(line.trimEnd());
    if (at) {
      errors.push({ file: at[1], line: Number(at[2]), column: Number(at[3]), code: at[4], message: at[5] });
      continue;
    }
    const any = bare.exec(line.trimEnd());
    if (any)
      errors.push({ code: any[1], message: any[2] });
  }
  return errors;
}
function render(result) {
  if (result.ok) {
    return `extensions/ compiles \u2014 nothing to fix.
  typescript ${result.version}, ${result.ms} ms`;
  }
  const lines = [];
  let last = null;
  for (const e of result.errors) {
    const where4 = e.file ?? "(this project)";
    if (where4 !== last) {
      lines.push(`
${where4}`);
      last = where4;
    }
    const at = e.line !== void 0 ? `${e.line}:${e.column}`.padEnd(8) : "".padEnd(8);
    lines.push(`  ${at}${e.code}  ${e.message}`);
  }
  const n = result.errors.length;
  lines.push(`
${n} error${n === 1 ? "" : "s"} \u2014 typescript ${result.version}, ${result.ms} ms`);
  if (n === 0)
    lines.push("(the compiler refused and this could not read its output \u2014 run `npx tsc --noEmit` here to see it)");
  return lines.join("\n").trimStart();
}

// dist/clone.js
import { spawn as spawn2 } from "node:child_process";
import fs8 from "node:fs";
import path7 from "node:path";

// dist/run.js
import { spawn } from "node:child_process";
import fs7 from "node:fs";
import path6 from "node:path";
var RunError = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "RunError";
  }
};
var isSegment = (name) => name !== "" && !name.startsWith(".") && !/[\\/]/.test(name);
function planRun(p, spec) {
  const script = spec.script;
  if (typeof script !== "string" || script === "") {
    throw new RunError("bad_params", "run needs a script name");
  }
  const repo = spec.repo;
  let cwd = p.root;
  if (repo !== void 0) {
    if (typeof repo !== "string" || !isSegment(repo)) {
      throw new RunError("bad_repo", `${JSON.stringify(String(repo))} is not a project name`, "a project is a directory under repos/ \u2014 `pewt repos` lists them");
    }
    cwd = path6.join(p.repos, repo);
    if (!fs7.existsSync(cwd)) {
      throw new RunError("no_repo", `no project named ${repo} in this pewter`, "`pewt repos` lists them");
    }
  }
  const manifest = path6.join(cwd, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs7.readFileSync(manifest, "utf8"));
  } catch {
    throw new RunError("no_manifest", `${where(p, cwd)} has no package.json to declare scripts in`, "`pewt run` runs what a project already declares; a project with no package.json declares nothing");
  }
  const scripts = pkg.scripts ?? {};
  const declared = scripts[script];
  if (typeof declared !== "string") {
    const names = Object.keys(scripts);
    throw new RunError("no_script", `${where(p, cwd)}/package.json declares no script named ${JSON.stringify(script)}`, names.length ? `it declares: ${names.join(", ")}` : "it declares no scripts at all");
  }
  return {
    script,
    repo,
    declared,
    cwd,
    label: `run ${script}${repo ? ` --repo ${repo}` : ""}`,
    where: where(p, cwd)
  };
}
function where(p, dir) {
  const rel = path6.relative(p.root, dir);
  return rel === "" ? p.name : rel;
}
function asRunSpec(spec) {
  const script = spec["script"];
  if (typeof script !== "string")
    return null;
  const repo = spec["repo"];
  return { script, ...typeof repo === "string" ? { repo } : {} };
}
var LINE_MAX = 64 * 1024;
function runKind(p, log) {
  return (ctx) => {
    const spec = asRunSpec(ctx.spec);
    if (!spec)
      throw new RunError("bad_params", "a run session needs a script name in its spec");
    let plan;
    try {
      plan = planRun(p, spec);
    } catch (e) {
      throw e instanceof RunError && e.hint ? new RunError(e.code, `${e.message} \u2014 ${e.hint}`) : e;
    }
    const child = spawn("npm", ["run", plan.script], {
      cwd: plan.cwd,
      env: childEnv(p),
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the host can stop the whole tree it
      // started. `npm run` is a parent — killing only npm leaves the build
      // it launched running, which is how orphaned vite servers happen.
      detached: true
    });
    const say = (frame) => ctx.write(JSON.stringify(frame));
    let lines = 0;
    const out = splitter((line) => {
      lines++;
      say({ o: line });
    });
    const err = splitter((line) => {
      lines++;
      say({ e: line });
    });
    child.stdout?.on("data", (chunk) => out.push(chunk));
    child.stderr?.on("data", (chunk) => err.push(chunk));
    let done = false;
    const finish = (code, signal) => {
      if (done)
        return;
      done = true;
      out.flush();
      err.flush();
      const exitCode = code ?? (signal ? 128 : null);
      say({ end: exitCode });
      log.info(`${plan.label} \u2192 exit ${exitCode ?? "?"}${signal ? ` (${signal})` : ""} \xB7 ${lines} line${lines === 1 ? "" : "s"}`);
      ctx.exit(exitCode);
    };
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      say({ e: `pewt: could not start npm \u2014 ${e.message}` });
      finish(127, null);
    });
    log.info(`${plan.label} \u2192 npm run ${plan.script} in ${plan.where}/ (pid ${child.pid ?? "?"})`);
    return {
      // What the client needs to print a header without asking again.
      result: { script: plan.script, repo: plan.repo ?? null, declared: plan.declared, where: plan.where, childPid: child.pid ?? null },
      onClose: () => stopTree(child, done)
    };
  };
}
function childEnv(p) {
  const bin = path6.join(p.root, "node_modules", ".bin");
  const current = process.env["PATH"] ?? "";
  return { ...process.env, PATH: current.includes(bin) ? current : `${bin}${path6.delimiter}${current}` };
}
function stopTree(child, alreadyDone) {
  if (alreadyDone || child.pid === void 0)
    return;
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
    }
  };
  signal("SIGTERM");
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      signal("SIGKILL");
  }, 2e3);
  t.unref();
}
function splitter(onLine) {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk.toString("utf8");
      for (; ; ) {
        const at = buf.indexOf("\n");
        if (at === -1)
          break;
        onLine(buf.slice(0, at).replace(/\r$/, ""));
        buf = buf.slice(at + 1);
      }
      if (buf.length > LINE_MAX) {
        onLine(buf.slice(0, LINE_MAX) + " \u2026[cut: no newline in 64 KB]");
        buf = "";
      }
    },
    flush() {
      if (buf !== "") {
        onLine(buf.replace(/\r$/, ""));
        buf = "";
      }
    }
  };
}
function asRunFrame(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object")
    return null;
  const f = value;
  if (typeof f["o"] === "string")
    return { o: f["o"] };
  if (typeof f["e"] === "string")
    return { e: f["e"] };
  if ("end" in f && (typeof f["end"] === "number" || f["end"] === null))
    return { end: f["end"] };
  return null;
}

// dist/clone.js
var CloneError = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "CloneError";
  }
};
function deriveName(url) {
  const trimmed = url.replace(/\/+$/, "");
  let tail;
  const scheme = trimmed.indexOf("://");
  if (scheme !== -1) {
    const rest = trimmed.slice(scheme + 3);
    const slash = rest.indexOf("/");
    if (slash === -1)
      return null;
    tail = rest.slice(slash + 1);
  } else {
    const colon = trimmed.indexOf(":");
    tail = colon !== -1 ? trimmed.slice(colon + 1) : trimmed;
  }
  const last = tail.split("/").pop() ?? "";
  const name = last.endsWith(".git") ? last.slice(0, -".git".length) : last;
  return isProjectName(name) ? name : null;
}
function planClone(p, spec) {
  const url = spec.url;
  if (typeof url !== "string" || url === "" || /\s/.test(url)) {
    throw new CloneError("bad_url", "clone needs a repository url", "https, ssh, or a local path \u2014 whatever your git can fetch");
  }
  const name = spec.name ?? deriveName(url);
  if (name === null) {
    throw new CloneError("bad_url", `cannot work out a project name from ${JSON.stringify(url)}`, "give it one: pewt repos clone <url> <name>");
  }
  if (!isProjectName(name)) {
    throw new CloneError("bad_name", `${JSON.stringify(name)} is not a project name`, "a project is a directory under repos/ \u2014 one path segment, not hidden");
  }
  const dest = path7.join(p.repos, name);
  if (fs8.existsSync(dest)) {
    throw new CloneError("exists", `there is already a project named ${name} in this pewter`, "pick another name: pewt repos clone <url> <name>");
  }
  return { url, name, dest, label: `repos.clone ${name}`, where: path7.join("repos", name) };
}
function asCloneSpec(spec) {
  const url = spec["url"];
  if (typeof url !== "string")
    return null;
  const name = spec["name"];
  return { url, ...typeof name === "string" ? { name } : {} };
}
var PROGRESS_MS = 200;
var LINE_MAX2 = 64 * 1024;
function cloneKind(p, log) {
  return (ctx) => {
    const spec = asCloneSpec(ctx.spec);
    if (!spec)
      throw new CloneError("bad_params", "a clone session needs a url in its spec");
    let plan;
    try {
      plan = planClone(p, spec);
    } catch (e) {
      throw e instanceof CloneError && e.hint ? new CloneError(e.code, `${e.message} \u2014 ${e.hint}`) : e;
    }
    fs8.mkdirSync(p.repos, { recursive: true });
    const child = spawn2("git", ["clone", "--progress", plan.url, plan.dest], {
      cwd: p.root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the host can stop what it started (D6) —
      // git spawns helpers (ssh, credential managers) and they go with it.
      detached: true
    });
    const say = (frame) => ctx.write(JSON.stringify(frame));
    let pendingProgress = null;
    let timer = null;
    const flushProgress = () => {
      timer = null;
      if (pendingProgress === null)
        return;
      say({ e: pendingProgress });
      pendingProgress = null;
    };
    const repaint = (line) => {
      pendingProgress = line;
      if (!timer) {
        timer = setTimeout(flushProgress, PROGRESS_MS);
        timer.unref();
      }
    };
    const errLine = (line) => {
      pendingProgress = null;
      say({ e: line });
    };
    const outLine = (line) => say({ o: line });
    const err = crSplitter(errLine, repaint);
    const out = crSplitter(outLine, repaint);
    child.stdout?.on("data", (chunk) => out.push(chunk));
    child.stderr?.on("data", (chunk) => err.push(chunk));
    let done = false;
    const finish = (code, signal) => {
      if (done)
        return;
      done = true;
      if (timer)
        clearTimeout(timer);
      flushProgress();
      out.flush();
      err.flush();
      const exitCode = code ?? (signal ? 128 : null);
      if (exitCode !== 0)
        fs8.rmSync(plan.dest, { recursive: true, force: true });
      say({ end: exitCode });
      log.info(`${plan.label} \u2192 exit ${exitCode ?? "?"}${signal ? ` (${signal})` : ""}`);
      ctx.exit(exitCode);
    };
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      say({ e: `pewt: could not start git \u2014 ${e.message}` });
      finish(127, null);
    });
    log.info(`${plan.label} \u2192 git clone ${plan.url} ${plan.where}/ (pid ${child.pid ?? "?"})`);
    return {
      // What the client needs to print a header without asking again.
      result: { url: plan.url, name: plan.name, where: plan.where, childPid: child.pid ?? null },
      onClose: () => stopTree(child, done)
    };
  };
}
function crSplitter(onLine, onRepaint) {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk.toString("utf8");
      for (; ; ) {
        const nl = buf.indexOf("\n");
        const cr = buf.indexOf("\r");
        if (nl === -1 && cr === -1)
          break;
        if (nl !== -1 && (cr === -1 || nl < cr || cr === nl - 1)) {
          onLine(buf.slice(0, cr === nl - 1 ? cr : nl));
          buf = buf.slice(nl + 1);
        } else {
          const line = buf.slice(0, cr);
          buf = buf.slice(cr + 1);
          if (line !== "")
            onRepaint(line);
        }
      }
      if (buf.length > LINE_MAX2) {
        onLine(buf.slice(0, LINE_MAX2) + " \u2026[cut: no newline in 64 KB]");
        buf = "";
      }
    },
    flush() {
      if (buf !== "") {
        onLine(buf);
        buf = "";
      }
    }
  };
}

// dist/install.js
import { spawn as spawn3 } from "node:child_process";
import fs9 from "node:fs";
import path8 from "node:path";
var InstallError = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "InstallError";
  }
};
function planInstall(p, spec) {
  const name = spec.name;
  if (typeof name !== "string" || !isProjectName(name)) {
    throw new InstallError("bad_name", `${JSON.stringify(String(name))} is not a project name`, "a project is a directory under repos/ \u2014 `pewt repos` lists them");
  }
  const cwd = path8.join(p.repos, name);
  if (!fs9.existsSync(cwd)) {
    throw new InstallError("no_repo", `no project named ${name} in this pewter`, "`pewt repos` lists them");
  }
  if (!fs9.existsSync(path8.join(cwd, "package.json"))) {
    throw new InstallError("no_manifest", `${name} has no package.json, so there is nothing to install`, "a manifest is what declares dependencies");
  }
  return { name, cwd, label: `install --repo ${name}`, where: path8.join("repos", name) };
}
function asInstallSpec(spec) {
  const name = spec["name"];
  return typeof name === "string" ? { name } : null;
}
var PROGRESS_MS2 = 200;
function installKind(p, log) {
  return (ctx) => {
    const spec = asInstallSpec(ctx.spec);
    if (!spec)
      throw new InstallError("bad_params", "an install session needs a project name in its spec");
    let plan;
    try {
      plan = planInstall(p, spec);
    } catch (e) {
      throw e instanceof InstallError && e.hint ? new InstallError(e.code, `${e.message} \u2014 ${e.hint}`) : e;
    }
    const child = spawn3("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: plan.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the host can stop the whole tree (D6) —
      // npm spawns lifecycle scripts, and they go with it.
      detached: true
    });
    const say = (frame) => ctx.write(JSON.stringify(frame));
    let pendingProgress = null;
    let timer = null;
    const flushProgress = () => {
      timer = null;
      if (pendingProgress === null)
        return;
      say({ e: pendingProgress });
      pendingProgress = null;
    };
    const repaint = (line) => {
      pendingProgress = line;
      if (!timer) {
        timer = setTimeout(flushProgress, PROGRESS_MS2);
        timer.unref();
      }
    };
    const out = crSplitter((line) => say({ o: line }), repaint);
    const err = crSplitter((line) => {
      pendingProgress = null;
      say({ e: line });
    }, repaint);
    child.stdout?.on("data", (chunk) => out.push(chunk));
    child.stderr?.on("data", (chunk) => err.push(chunk));
    let done = false;
    const finish = (code, signal) => {
      if (done)
        return;
      done = true;
      if (timer)
        clearTimeout(timer);
      flushProgress();
      out.flush();
      err.flush();
      const exitCode = code ?? (signal ? 128 : null);
      say({ end: exitCode });
      log.info(`${plan.label} \u2192 exit ${exitCode ?? "?"}${signal ? ` (${signal})` : ""}`);
      ctx.exit(exitCode);
    };
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      say({ e: `pewt: could not start npm \u2014 ${e.message}` });
      finish(127, null);
    });
    log.info(`${plan.label} \u2192 npm install in ${plan.where}/ (pid ${child.pid ?? "?"})`);
    return {
      result: { name: plan.name, where: plan.where, childPid: child.pid ?? null },
      onClose: () => stopTree(child, done)
    };
  };
}

// dist/node-fs.js
import fs10 from "node:fs/promises";
import path9 from "node:path";
var NamedError = class extends Error {
  constructor(name, msg) {
    super(msg);
    this.name = name;
  }
};
var NodeDirectory = class _NodeDirectory {
  dirPath;
  constructor(dirPath) {
    this.dirPath = dirPath;
  }
  async getDirectoryHandle(name, options) {
    const p = path9.join(this.dirPath, name);
    if (options?.create) {
      await fs10.mkdir(p, { recursive: true });
    } else {
      const st = await fs10.stat(p).catch(() => null);
      if (!st?.isDirectory())
        throw new NamedError("NotFoundError", `no directory ${name}`);
    }
    return new _NodeDirectory(p);
  }
  async getFileHandle(name, options) {
    const p = path9.join(this.dirPath, name);
    const st = await fs10.stat(p).catch(() => null);
    if (!st?.isFile()) {
      if (!options?.create)
        throw new NamedError("NotFoundError", `no file ${name}`);
      await (await fs10.open(p, "a")).close();
    }
    return new NodeFile(p, name);
  }
  async *keys() {
    yield* await fs10.readdir(this.dirPath);
  }
};
var NodeFile = class {
  filePath;
  name;
  constructor(filePath2, name) {
    this.filePath = filePath2;
    this.name = name;
  }
  async getFile() {
    const [st, buf] = await Promise.all([fs10.stat(this.filePath), fs10.readFile(this.filePath)]);
    return new File([buf], this.name, { lastModified: Math.round(st.mtimeMs) });
  }
  async createWritable() {
    const tmp = `${this.filePath}.${Math.random().toString(36).slice(2, 8)}.crswap`;
    const fh = await fs10.open(tmp, "w");
    const target = this.filePath;
    return {
      async write(data) {
        await fh.write(data);
      },
      async close() {
        await fh.close();
        await fs10.rename(tmp, target);
      }
    };
  }
};

// dist/agent.js
import { spawn as spawn4 } from "node:child_process";
import fs11 from "node:fs";
import os from "node:os";
import path10 from "node:path";

// dist/framing.js
var MAX_LINE_BYTES = 1 << 20;
var LineSplitter = class {
  ev;
  max;
  #parts = [];
  #len = 0;
  #dropping = false;
  constructor(ev, max = MAX_LINE_BYTES) {
    this.ev = ev;
    this.max = max;
  }
  push(chunk) {
    let rest = chunk;
    for (; ; ) {
      const nl = rest.indexOf(10);
      if (nl < 0)
        break;
      const head = rest.subarray(0, nl);
      rest = rest.subarray(nl + 1);
      if (this.#dropping) {
        this.#dropping = false;
        this.#reset();
        continue;
      }
      this.#parts.push(head);
      this.#len += head.length;
      const text = Buffer.concat(this.#parts, this.#len).toString("utf8");
      this.#reset();
      const trimmed = text.endsWith("\r") ? text.slice(0, -1) : text;
      if (trimmed.length > 0)
        this.ev.line(trimmed);
    }
    if (rest.length === 0)
      return;
    if (this.#dropping)
      return;
    this.#parts.push(rest);
    this.#len += rest.length;
    if (this.#len > this.max) {
      this.ev.overflow(this.#len);
      this.#dropping = true;
      this.#reset();
    }
  }
  /** Bytes held back waiting for a newline (diagnostics; a child that exits
   *  mid-line leaves them here — they are never delivered as a message). */
  get pending() {
    return this.#len;
  }
  #reset() {
    this.#parts = [];
    this.#len = 0;
  }
};
function classify(text) {
  let parsed2;
  try {
    parsed2 = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not JSON (${e instanceof Error ? e.message : String(e)})`, text };
  }
  if (parsed2 === null || typeof parsed2 !== "object" || Array.isArray(parsed2)) {
    return { ok: false, reason: "not a JSON object", text };
  }
  return { ok: true, text };
}
function isJsonRpc(text) {
  try {
    return JSON.parse(text).jsonrpc === "2.0";
  } catch {
    return false;
  }
}
function toAgentLine(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not valid UTF-8" };
  }
  const body = text.replace(/\r?\n$/, "");
  if (body.includes("\n"))
    return { ok: false, reason: "more than one line in a DATA frame" };
  const c = classify(body);
  if (!c.ok)
    return { ok: false, reason: c.reason };
  return { ok: true, line: body + "\n" };
}

// dist/agent.js
var STDERR_KEEP = 200;
var STDERR_LINE_MAX = 2e3;
var KILL_GRACE_MS = 2e3;
var AgentError = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "AgentError";
  }
};
var isSegment2 = (name) => name !== "" && !name.startsWith(".") && !/[\\/]/.test(name);
function planAgent(p, spec) {
  let cwd = p.root;
  const repo = spec.repo;
  if (repo !== void 0) {
    if (typeof repo !== "string" || !isSegment2(repo)) {
      throw new AgentError("bad_repo", `${JSON.stringify(String(repo))} is not a project name`, "a project is a directory under repos/ \u2014 `pewt repos` lists them");
    }
    cwd = path10.join(p.repos, repo);
    if (!fs11.existsSync(cwd)) {
      throw new AgentError("no_repo", `no project named ${repo} in this pewter`, "`pewt repos` lists them");
    }
  }
  const asked = spec.agent;
  let adapter;
  if (asked === void 0) {
    adapter = ADAPTERS.find((a) => resolve(p, a) !== null) ?? null;
    if (!adapter) {
      throw new AgentError("no_agent", "this pewter has no ACP adapter installed", `an adapter is an ordinary dependency \u2014 ${ADAPTERS.map((a) => installLine(a)).join(", or ")}`);
    }
  } else {
    adapter = findAdapter(asked);
    if (!adapter) {
      throw new AgentError("unknown_agent", `no adapter named ${JSON.stringify(String(asked))}`, `this build knows: ${ADAPTERS.map((a) => a.name).join(", ")} \u2014 \`pewt agents\` lists them`);
    }
  }
  const found = resolve(p, adapter);
  if (!found) {
    throw new AgentError("not_installed", `${adapter.name} is not installed in this pewter`, `${installLine(adapter)} \u2014 it is pinned in your lockfile and comes back with \`git clone && npm i\``);
  }
  return {
    adapter,
    bin: found.bin,
    version: found.version,
    unmeasured: found.version !== adapter.measured,
    ...repo !== void 0 ? { repo } : {},
    cwd,
    where: where2(p, cwd),
    label: `agent ${adapter.name}${repo ? ` --repo ${repo}` : ""}`
  };
}
function where2(p, dir) {
  const rel = path10.relative(p.root, dir);
  return rel === "" ? p.name : rel;
}
function asAgentSpec(spec) {
  const agent = spec["agent"];
  const repo = spec["repo"];
  return {
    ...typeof agent === "string" ? { agent } : {},
    ...typeof repo === "string" ? { repo } : {}
  };
}
var ENV_FLOOR = ["PATH", "HOME", "TERM", "LANG", "USER", "LOGNAME", "SHELL", "TMPDIR"];
function agentEnv(p, from2 = process.env) {
  const env = {};
  for (const name of ENV_FLOOR) {
    const value = from2[name];
    if (value !== void 0)
      env[name] = value;
  }
  env["HOME"] ??= os.homedir();
  env["TERM"] = "dumb";
  const bin = path10.join(p.root, "node_modules", ".bin");
  const current = env["PATH"] ?? "";
  env["PATH"] = current.includes(bin) ? current : `${bin}${path10.delimiter}${current}`;
  return env;
}
function agentKind(p, log) {
  return (ctx) => {
    let plan;
    try {
      plan = planAgent(p, asAgentSpec(ctx.spec));
    } catch (e) {
      throw e instanceof AgentError && e.hint ? new AgentError(e.code, `${e.message} \u2014 ${e.hint}`) : e;
    }
    const child = spawn4(plan.bin, [], { cwd: plan.cwd, env: agentEnv(p), stdio: ["pipe", "pipe", "pipe"] });
    const counters = { messagesOut: 0, messagesIn: 0, junkLines: 0, nonRpc: 0, refusedIn: 0, overflows: 0 };
    const stderr = [];
    const keep = (line) => {
      const kept = line.length > STDERR_LINE_MAX ? `${line.slice(0, STDERR_LINE_MAX)}\u2026` : line;
      stderr.push(kept);
      if (stderr.length > STDERR_KEEP)
        stderr.splice(0, stderr.length - STDERR_KEEP);
      log.warn(`${plan.adapter.name}: ${kept}`);
    };
    const splitter2 = new LineSplitter({
      line: (text) => {
        const c = classify(text);
        if (!c.ok) {
          counters.junkLines++;
          keep(`[stdout, not a message: ${c.reason}] ${text.slice(0, 300)}`);
          return;
        }
        if (!isJsonRpc(text))
          counters.nonRpc++;
        counters.messagesOut++;
        ctx.write(text);
      },
      overflow: (bytes) => {
        counters.overflows++;
        keep(`[dropped an over-long stdout line: ${bytes} bytes]`);
      }
    });
    child.stdout.on("data", (chunk) => splitter2.push(chunk));
    let errBuf = "";
    child.stderr.on("data", (chunk) => {
      errBuf += chunk.toString("utf8");
      const lines = errBuf.split("\n");
      errBuf = lines.pop() ?? "";
      for (const l of lines)
        if (l.trim())
          keep(l);
    });
    let exited = false;
    const finish = (code, signal) => {
      if (exited)
        return;
      exited = true;
      if (errBuf.trim())
        keep(errBuf.trim());
      log.info(`${plan.label} \u2192 exit ${code ?? "?"}${signal ? ` (${signal})` : ""} \xB7 ${counters.messagesOut} out, ${counters.messagesIn} in`);
      ctx.exit(code ?? (signal ? 128 : null));
    };
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      keep(`[spawn error] ${e.message}`);
      finish(127, null);
    });
    child.stdin.on("error", (e) => keep(`[stdin] ${e.message}`));
    log.info(`${plan.label} \u2192 ${plan.adapter.bin}${plan.version ? ` ${plan.version}` : ""} in ${plan.where}/ (pid ${child.pid ?? "?"})`);
    return {
      // What a client needs to render a header without asking again. No path:
      // where npm put the binary is not something a tab needs to use it.
      result: {
        agent: plan.adapter.name,
        title: plan.adapter.title,
        protocol: "acp",
        version: plan.version,
        asks: plan.adapter.asks,
        unmeasured: plan.unmeasured,
        where: plan.where,
        // The cwd, absolute — ACP's `session/new` requires one, and whoever
        // holds the other end is the ACP client, so it has to have it. The
        // same deliberate exception `acp-demo`'s `acp/info` makes to "names,
        // never paths": the path is a label for the folder the page was
        // already granted, not a disclosure of anything beyond it.
        cwd: plan.cwd,
        // The host stamps `pid` with its own (D13: kinds run in-process), so
        // the child's needs its own name.
        agentPid: child.pid ?? null
      },
      // ---- uplink: one DATA frame → one line on the agent's stdin
      onData: (bytes) => {
        const r = toAgentLine(bytes);
        if (!r.ok) {
          counters.refusedIn++;
          keep(`[refused an uplink frame: ${r.reason}]`);
          return;
        }
        counters.messagesIn++;
        if (!child.stdin.destroyed)
          child.stdin.write(r.line);
      },
      methods: {
        /** Everything that did not fit the payload channel. A stalled agent
         *  is diagnosable by whoever is driving it rather than only from the
         *  terminal the host happens to be running in. */
        "agent/diagnostics": () => ({ ...counters, pendingBytes: splitter2.pending, exited, stderr: [...stderr] })
      },
      onClose: () => {
        if (exited)
          return;
        child.kill("SIGTERM");
        const t = setTimeout(() => {
          if (!exited)
            child.kill("SIGKILL");
        }, KILL_GRACE_MS);
        t.unref();
      }
    };
  };
}

// dist/paths.js
import path11 from "node:path";
import { safeRelPath } from "pewter";
function inPewter(typed, root, cwd) {
  const landed = path11.resolve(cwd, typed);
  const rel = path11.relative(root, landed);
  if (rel !== "" && !rel.startsWith("..") && !path11.isAbsolute(rel))
    return { path: rel.split(path11.sep).join("/") };
  const here = path11.relative(root, path11.resolve(cwd));
  const away = here.startsWith("..") || path11.isAbsolute(here);
  if (away && !path11.isAbsolute(typed) && safeRelPath(typed))
    return { path: safeRelPath(typed) };
  return { outside: landed };
}

// dist/stream.js
var WAITING_MS = 1200;
var STATUS_GRACE_MS = 500;
async function runOnHost(dir, method, spec, opts = {}) {
  const client = await connect(dir);
  const session = client.createSession({ kind: method, client: "pewt-cli", ...spec }, { pollMs: opts.pollMs ?? 15, heartbeatMs: 0 });
  let settle = null;
  const finished = new Promise((resolve2) => {
    settle = resolve2;
  });
  session.on("data", (bytes) => {
    const frame = asRunFrame(bytes);
    if (!frame)
      return;
    if ("o" in frame)
      opts.onLine?.(frame.o, "out");
    else if ("e" in frame)
      opts.onLine?.(frame.e, "err");
    else
      settle?.({ exitCode: frame.end, ended: "exit" });
  });
  let backstop;
  session.on("status", (status) => {
    if (status.state !== "exited" && status.state !== "error")
      return;
    if (backstop)
      return;
    backstop = setTimeout(() => settle?.({ exitCode: status.exitCode ?? null, ended: "host_gone" }), STATUS_GRACE_MS);
    backstop.unref();
  });
  const waiting = setTimeout(() => opts.onWaiting?.(), WAITING_MS);
  try {
    const started = await Promise.race([
      session.ready,
      new Promise((_, reject) => setTimeout(() => reject(new CallError("timeout", "the host never answered the request to start this run")), opts.answerMs ?? 10 * 6e4).unref())
    ]).catch((e) => {
      if (e instanceof CallError)
        throw e;
      if (e instanceof RpcError) {
        const data = e.data ?? {};
        throw new CallError("refused", e.message, data.code, data.hint);
      }
      throw new CallError("transport", e instanceof Error ? e.message : String(e));
    });
    clearTimeout(waiting);
    opts.onStart?.(started);
    return await finished;
  } finally {
    clearTimeout(waiting);
    await session.close().catch(() => {
    });
  }
}
async function shellOnHost(dir, spec, opts) {
  const client = await connect(dir);
  const session = client.createSession({ kind: "shell", client: "pewt-cli", ...spec }, { pollMs: opts.pollMs ?? 15, heartbeatMs: 0 });
  let settle = null;
  const exit = new Promise((resolve2) => {
    settle = resolve2;
  });
  const decoder = new TextDecoder();
  session.on("data", (bytes) => opts.onData(decoder.decode(bytes, { stream: true })));
  let grace;
  session.on("status", (status) => {
    if (status.state !== "exited" && status.state !== "error" || grace)
      return;
    const outcome = status.state === "exited" ? { exitCode: status.exitCode ?? null, ended: "exit" } : { exitCode: null, ended: "host_gone" };
    grace = setTimeout(() => settle?.(outcome), STATUS_GRACE_MS);
    grace.unref();
  });
  const waiting = setTimeout(() => opts.onWaiting?.(), WAITING_MS);
  try {
    const started = await Promise.race([
      session.ready,
      new Promise((_, reject) => setTimeout(() => reject(new CallError("timeout", "the host never answered the request to open this shell")), opts.answerMs ?? 10 * 6e4).unref())
    ]);
    opts.onStart?.(started);
  } catch (e) {
    await session.close().catch(() => {
    });
    if (e instanceof CallError)
      throw e;
    if (e instanceof RpcError) {
      const data = e.data ?? {};
      throw new CallError("refused", e.message, data.code, data.hint);
    }
    throw new CallError("transport", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(waiting);
  }
  return {
    write: (data) => session.sendData(data),
    resize: (cols, rows) => session.notify("resize", { cols, rows }),
    close: async () => {
      await session.close().catch(() => {
      });
      settle?.({ exitCode: null, ended: "exit" });
    },
    exit: exit.finally(() => void session.close().catch(() => {
    }))
  };
}
async function agentOnHost(dir, spec, opts) {
  const client = await connect(dir);
  const session = client.createSession({ kind: "agent", client: "pewt-cli", ...spec }, { pollMs: opts.pollMs ?? 15, heartbeatMs: 0 });
  let settle = null;
  const exit = new Promise((resolve2) => {
    settle = resolve2;
  });
  session.on("data", (bytes) => {
    try {
      opts.onMessage(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
    }
  });
  let grace;
  session.on("status", (status) => {
    if (status.state !== "exited" && status.state !== "error" || grace)
      return;
    const outcome = status.state === "exited" ? { exitCode: status.exitCode ?? null, ended: "exit" } : { exitCode: null, ended: "host_gone" };
    grace = setTimeout(() => settle?.(outcome), STATUS_GRACE_MS);
    grace.unref();
  });
  const waiting = setTimeout(() => opts.onWaiting?.(), WAITING_MS);
  try {
    const started = await Promise.race([
      session.ready,
      new Promise((_, reject) => setTimeout(() => reject(new CallError("timeout", "the host never answered the request to start this agent")), opts.answerMs ?? 10 * 6e4).unref())
    ]);
    opts.onStart?.(started);
  } catch (e) {
    await session.close().catch(() => {
    });
    if (e instanceof CallError)
      throw e;
    if (e instanceof RpcError) {
      const data = e.data ?? {};
      throw new CallError("refused", e.message, data.code, data.hint);
    }
    throw new CallError("transport", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(waiting);
  }
  return {
    send: (message) => session.sendData(JSON.stringify(message)),
    close: async () => {
      await session.close().catch(() => {
      });
      settle?.({ exitCode: null, ended: "exit" });
    },
    diagnostics: async () => {
      const { result } = await session.request("agent/diagnostics", {}, { timeoutMs: 5e3 });
      return result;
    },
    // Unlike a shell's, this does not close the session when it settles: an
    // agent that died has just put the reason on stderr, and `diagnostics()`
    // is how anybody reads it. Closing here would reap the session the
    // question has to be asked on. The caller closes when it is done.
    exit
  };
}

// dist/pipe.js
async function pipeAgent(dir, spec, streams, opts = {}) {
  const { input, output, errors } = streams;
  const agent = await agentOnHost(dir, spec, {
    // Re-serialized rather than forwarded verbatim. The alternative is to
    // pass the bytes through, which would be a cheaper pipe and a worse one:
    // what a caller reads here would then be whatever the agent wrote, and
    // the framing contract this session enforces would be invisible on the
    // way out.
    onMessage: (message) => output.write(`${JSON.stringify(message)}
`),
    ...opts.onWaiting ? { onWaiting: opts.onWaiting } : {}
  });
  const splitter2 = new LineSplitter({
    line: (text) => {
      if (!text.trim())
        return;
      let message;
      try {
        message = JSON.parse(text);
      } catch (e) {
        errors.write(`pewt: not JSON, so not sent \u2014 ${e instanceof Error ? e.message : String(e)}
`);
        return;
      }
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        errors.write("pewt: an ACP message is a JSON object; that line was not one, so it was not sent\n");
        return;
      }
      agent.send(message);
    },
    overflow: (bytes) => errors.write(`pewt: dropped a ${bytes}-byte line with no newline
`)
  });
  const seen = { last: null };
  const watch = setInterval(() => void agent.diagnostics().then((d) => seen.last = d).catch(() => {
  }), 1e3);
  watch.unref();
  const onInput = (chunk) => splitter2.push(chunk);
  const onEnd = () => {
  };
  let outcome = null;
  try {
    input.on("data", onInput);
    input.on("end", onEnd);
    input.resume();
    outcome = await agent.exit;
    return outcome;
  } finally {
    clearInterval(watch);
    input.off("data", onInput);
    input.off("end", onEnd);
    input.pause();
    const said = seen.last;
    if (said?.junkLines) {
      errors.write(`pewt: the agent wrote ${said.junkLines} non-message line${said.junkLines === 1 ? "" : "s"} to stdout; they were never delivered
`);
    }
    if (said?.stderr.length) {
      errors.write(`pewt: the agent wrote to stderr \u2014 the last ${said.stderr.length} line${said.stderr.length === 1 ? "" : "s"} seen while it ran:
`);
      for (const line of said.stderr)
        errors.write(`  ${line}
`);
    }
    if (outcome === null || outcome.exitCode !== 0) {
      errors.write("pewt: anything it said on the way out is on the terminal running `pewt serve` (https://github.com/dglazkov/fsio/issues/98)\n");
    }
    await agent.close();
  }
}

// dist/serve.js
import fs15 from "node:fs";
import os2 from "node:os";
import path15 from "node:path";

// ../host/dist/host-server.js
import fs12 from "node:fs";
import path12 from "node:path";
import { spawn as cpSpawn } from "node:child_process";
var errMsg2 = (e) => e instanceof Error ? e.message : String(e);
var SILENT_LOGGER = { info() {
}, warn() {
}, error() {
} };
var DEFAULT_TIMINGS = {
  heartbeatMs: 2e3,
  safetyPollMs: 250,
  hotWindowMs: 2e3,
  idleGcMs: 5 * 6e4,
  idleSweepMs: 3e4,
  detachAfterMs: 18e4,
  staleGraceMs: 6e4,
  closeDelayMs: 500,
  retryMs: 5,
  killGraceMs: 3e3
};
var DEFAULT_LIMITS = {
  segMax: 8 * 1024 * 1024,
  ackWindow: 4 * 1024 * 1024,
  ackResume: 2 * 1024 * 1024
};
var DEFAULT_TRANSCRIPTS = {
  keep: 10,
  maxBytes: 32 * 1024 * 1024
};
var CLIENT_DIR = "client";
var CLIENT_DIR_CAP = 8;
function writeFileAtomic(file, data) {
  const tmp = path12.join(path12.dirname(file), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs12.writeFileSync(tmp, data);
  fs12.renameSync(tmp, file);
}
function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}
function canonServices(d) {
  const caps = (Array.isArray(d.capabilities) ? d.capabilities : []).filter((c) => typeof c === "string");
  const kinds = (Array.isArray(d.kinds) ? d.kinds : []).filter((k) => !!k && typeof k.name === "string").sort((a, b) => a.name.localeCompare(b.name)).map((k) => ({
    name: k.name,
    ...k.needsGrant ? { needsGrant: true } : {},
    // Transcribed, never interpreted (D31) — but it must be a JSON
    // object, or the document stops being one shape for every reader.
    ...isPlainObject(k.detail) ? { detail: k.detail } : {}
  }));
  const ws = (Array.isArray(d.workspaces) ? d.workspaces : []).filter((w) => !!w && typeof w.name === "string").sort((a, b) => a.name.localeCompare(b.name)).map((w) => typeof w.label === "string" ? { name: w.name, label: w.label } : { name: w.name });
  const url = d.consent && typeof d.consent.url === "string" ? d.consent.url : null;
  return {
    protocol: typeof d.protocol === "number" ? d.protocol : PROTOCOL_VERSION,
    capabilities: [...new Set(caps)].sort(),
    kinds,
    ...Array.isArray(d.workspaces) ? { workspaces: ws } : {},
    ...url === null ? {} : { consent: { url } }
  };
}
var isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var echoSafe = (s) => s.replace(new RegExp("\\p{C}", "gu"), "").slice(0, 64);
var within = (root, p) => {
  const rel = path12.relative(root, p);
  return rel === "" || !rel.startsWith("..") && !path12.isAbsolute(rel);
};
function contains(root, p) {
  if (!within(root, p))
    return false;
  try {
    return within(fs12.realpathSync(root), fs12.realpathSync(p));
  } catch {
    return true;
  }
}
function readJson(file) {
  try {
    return JSON.parse(fs12.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
var ptyModCache;
async function loadPty() {
  if (ptyModCache !== void 0)
    return ptyModCache;
  try {
    const specifier = "node-pty";
    ptyModCache = await import(specifier);
  } catch {
    ptyModCache = null;
  }
  return ptyModCache;
}
var Session = class {
  host;
  id;
  dir;
  spawn = null;
  // params from the JSON-RPC request in spawn.json
  spawnId = null;
  // request id to answer (null = legacy bare spec)
  spawnAnswered = false;
  started = false;
  approved = false;
  // spawn policy said yes (D12); gates incoming processing
  exited = false;
  // process/kind reported exit (session dir still readable, D6)
  done = false;
  nextInSeq = null;
  // discovered from the smallest chunk present
  // Output stream state: segmented log + cumulative byte accounting.
  outGen = 0;
  // current segment number
  segBytes = 0;
  // bytes in current segment
  prevFinal = 0;
  // final size of segment outGen-1 (for reader handoff)
  outTotal = 0;
  // cumulative bytes ever appended
  ackTotal = 0;
  // cumulative bytes the client has confirmed consuming
  paused = false;
  // output paused waiting for acks
  doneSegs = [];
  // finished segments
  proc = null;
  usesPty = false;
  // Base directory for a spawned child (D22): the resolved workspace root
  // in hub mode, the shared dir otherwise. Resolved once, before the
  // policy sees it, so the judged cwd and the executed cwd cannot drift.
  root = null;
  workspace = null;
  // its name — the only half that may travel
  kindSession = null;
  // registered kinds (D13)
  watchers = [];
  retryTimer = null;
  lastActivity = Date.now();
  // Client-presence accounting (D17): any consumed uplink chunk counts as
  // "seen"; only clients that ever sent a heartbeat are judged by it —
  // legacy clients keep the pre-heartbeat behavior (blunt idle GC only).
  lastClientSeen = Date.now();
  heartbeatAware = false;
  detached = false;
  // Writer epoch (D18): 0 = the spawning client, uplink `in/`. Each attach
  // grant bumps it and moves the uplink to `in.<epoch>/` — the fence that
  // keeps one-writer-per-file true across takeovers (F8/D6).
  epoch = 0;
  statusBase = null;
  constructor(host, id) {
    this.host = host;
    this.id = id;
    this.dir = path12.join(host.sessionsDir, id);
  }
  /** Current writer's uplink dir (D18): `in/` for epoch 0, `in.<epoch>/`
   *  after an attach takeover. Only this dir is ever consumed. */
  get inDir() {
    return path12.join(this.dir, this.epoch === 0 ? "in" : `in.${this.epoch}`);
  }
  get pty() {
    return this.usesPty ? this.proc : null;
  }
  get child() {
    return this.usesPty || !this.proc ? null : this.proc;
  }
  segPath(gen) {
    return path12.join(this.dir, segName(gen));
  }
  // Append with open/write/close per call, then bump a rename-committed
  // doorbell file. Rationale (measured, spec/FINDINGS.md F1): on macOS,
  // appends through a long-held fd are nearly invisible to FSEvents-backed
  // watchers — events fire on close() and renames, not on in-place writes.
  // Segments always rotate on frame boundaries (rotation happens between
  // appends), so every segment is independently parseable.
  appendFrame(type, payload) {
    const bytes = encodeFrame(type, payload);
    const fd = fs12.openSync(this.segPath(this.outGen), "a");
    fs12.writeSync(fd, bytes);
    fs12.closeSync(fd);
    this.segBytes += bytes.length;
    this.outTotal += bytes.length;
    if (this.segBytes >= this.host.limits.segMax) {
      this.doneSegs.push({ gen: this.outGen, endTotal: this.outTotal });
      this.prevFinal = this.segBytes;
      this.outGen++;
      this.segBytes = 0;
      this.gcSegments();
    }
    const sig = { gen: this.outGen, size: this.segBytes, prevFinal: this.prevFinal, total: this.outTotal };
    writeFileAtomic(path12.join(this.dir, "out.sig"), JSON.stringify(sig));
    this.checkWindow();
  }
  ack(total) {
    this.ackTotal = Math.max(this.ackTotal, total);
    this.gcSegments();
    this.checkWindow();
  }
  gcSegments() {
    while (this.doneSegs.length > 0 && this.ackTotal >= this.doneSegs[0].endTotal) {
      const seg = this.doneSegs.shift();
      try {
        fs12.unlinkSync(this.segPath(seg.gen));
      } catch {
      }
    }
  }
  checkWindow() {
    if (!this.proc)
      return;
    const { ackWindow, ackResume } = this.host.limits;
    const unacked = this.outTotal - this.ackTotal;
    if (!this.paused && unacked > ackWindow) {
      this.paused = true;
      try {
        if (this.pty)
          this.pty.pause();
        else {
          this.child.stdout.pause();
          this.child.stderr.pause();
        }
      } catch {
      }
      this.host.log.info(`session ${this.id}: output paused (${(unacked / 1048576).toFixed(1)} MB unacked)`);
    } else if (this.paused && unacked <= ackResume) {
      this.paused = false;
      try {
        if (this.pty)
          this.pty.resume();
        else {
          this.child.stdout.resume();
          this.child.stderr.resume();
        }
      } catch {
      }
      this.host.log.info(`session ${this.id}: output resumed`);
    }
  }
  appendJson(type, obj) {
    this.appendFrame(type, new TextEncoder().encode(JSON.stringify(obj)));
  }
  setStatus(obj) {
    const { detached: _, ...base } = obj;
    this.statusBase = base;
    writeJsonAtomic(path12.join(this.dir, "status.json"), { t: now(), ...obj });
  }
  /** Toggle the D17 detached marker in status.json (no-op until the first
   *  setStatus, and when already in the requested state). */
  setDetached(detached) {
    if (this.detached === detached || !this.statusBase)
      return;
    this.detached = detached;
    this.setStatus(detached ? { ...this.statusBase, detached: true } : this.statusBase);
  }
  /** Whether a durable status record exists yet (attach needs one: there
   *  is nothing to attach to before the spawn outcome is known). */
  get hasStatus() {
    return this.statusBase !== null;
  }
  /** Merge fields into the durable status record and rewrite it,
   *  preserving the detached marker layer (D18: attach folds `writer` in). */
  patchStatus(patch) {
    if (!this.statusBase)
      return;
    const base = { ...this.statusBase, ...patch };
    this.setStatus(this.detached ? { ...base, detached: true } : base);
  }
  // Answer the spawn request (once) on the out stream. Errors get real
  // JSON-RPC error objects instead of a status.json state the client must
  // poll for and interpret. Duplicated answers (host restart re-adopting a
  // session) are fine: clients ignore responses with unknown ids.
  answerSpawn(make) {
    if (this.spawnId === null || this.spawnAnswered)
      return;
    this.spawnAnswered = true;
    this.appendJson(FrameType.RPC, make(this.spawnId));
  }
  spawnOk(result) {
    this.answerSpawn((id) => rpcResult(id, result));
  }
  spawnFail(code, message) {
    this.answerSpawn((id) => rpcError(id, code, message));
  }
  scheduleRetry() {
    if (this.retryTimer)
      return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.host.scheduleScan();
    }, this.host.timings.retryMs);
  }
  close() {
    this.done = true;
    try {
      this.kindSession?.onClose?.();
    } catch (e) {
      this.host.log.warn(`session ${this.id}: kind onClose threw: ${errMsg2(e)}`);
    }
    this.kindSession = null;
    for (const w of this.watchers)
      w?.close();
    this.watchers = [];
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.proc) {
      try {
        if (this.pty)
          this.pty.kill();
        else
          this.child.kill("SIGTERM");
      } catch {
      }
      this.proc = null;
    }
  }
};
var HostServer = class {
  sharedDir;
  fsioDir;
  sessionsDir;
  /** where ended sessions' out logs are kept when retention is on (#119). */
  transcriptsDir;
  allowShell;
  onSpawnRequest;
  workspaces;
  watchEnabled;
  hotPollMs;
  pollMs;
  timings;
  limits;
  log;
  /** true once node-pty was found at start(). */
  ptyAvailable = false;
  fresh;
  /** null = off, and off means an ended session leaves nothing behind. */
  transcripts;
  takeover;
  gitignore;
  ptyOpt;
  ptyMod = null;
  sessions = /* @__PURE__ */ new Map();
  // Kind registry (D13). echo is just the trivial entry; shell stays
  // native (pty + flow-control pause/resume have no kind-API hooks yet).
  kinds = /* @__PURE__ */ new Map([["echo", () => ({})]]);
  timers = [];
  // The hot poll is a lifecycle of its own: armed by traffic, disarmed by
  // silence (markActive) — not one of the always-on `timers`.
  hotTimer = null;
  lastTraffic = 0;
  pendingCleanups = /* @__PURE__ */ new Set();
  rootWatcher = null;
  hbSeq = 0;
  startedAt = 0;
  running = false;
  // Service directory (D24): the embedder's contribution, the last body we
  // published (canonical JSON, rev excluded — the change test), and the rev
  // the heartbeat advertises.
  servicesInput;
  servicesBody = null;
  servicesRev = 0;
  namedWorkspaces;
  // fs.watch events are treated purely as wakeups; every wake runs a full,
  // idempotent scan. A slow safety poll catches anything watch misses.
  scanning = false;
  rescan = false;
  constructor(opts) {
    this.sharedDir = path12.resolve(opts.root);
    this.fsioDir = path12.join(this.sharedDir, ".fsio");
    this.sessionsDir = path12.join(this.fsioDir, "sessions");
    this.transcriptsDir = path12.join(this.fsioDir, "transcripts");
    this.allowShell = opts.allowShell ?? false;
    this.onSpawnRequest = opts.onSpawnRequest ?? null;
    const ownName = opts.workspaceName;
    this.namedWorkspaces = !!opts.workspaces || !!ownName;
    this.servicesInput = opts.services ?? {};
    this.workspaces = opts.workspaces ?? ((name) => name === void 0 || name === ownName ? { root: this.sharedDir, ...name ? { name } : {} } : { error: `unknown workspace: ${echoSafe(name)}` });
    this.fresh = opts.fresh ?? false;
    this.transcripts = opts.transcripts ? { ...DEFAULT_TRANSCRIPTS, ...opts.transcripts === true ? {} : opts.transcripts } : null;
    this.takeover = opts.takeover ?? false;
    this.gitignore = opts.gitignore ?? true;
    this.watchEnabled = opts.watch ?? true;
    this.hotPollMs = opts.hotPollMs ?? 5;
    this.pollMs = opts.pollMs ?? 0;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.log = opts.logger ?? SILENT_LOGGER;
    this.ptyOpt = opts.pty;
  }
  /** Read-only view of the sessions this host is serving (D14): the
   *  introspection surface for confirmation UIs (#16) and reattach (#3).
   *  Snapshots — mutating them changes nothing. */
  listSessions() {
    const infos = [];
    for (const s of this.sessions.values()) {
      const phase = s.done ? "done" : s.exited ? "exited" : s.approved ? "running" : s.started ? "pending" : "adopted";
      const info = {
        id: s.id,
        kind: s.spawn ? s.spawn.kind ?? "echo" : null,
        client: s.spawn?.client,
        origin: s.spawn?.origin,
        phase,
        bytesOut: s.outTotal,
        bytesAcked: s.ackTotal,
        lastActivityAt: s.lastActivity,
        detached: s.detached,
        lastClientSeenAt: s.lastClientSeen,
        epoch: s.epoch
      };
      if (phase === "running") {
        info.pid = s.proc ? s.proc.pid ?? process.pid : process.pid;
        if (s.proc)
          info.pty = s.usesPty;
      }
      infos.push(info);
    }
    return infos;
  }
  /** Register a session kind (D13): `handler` runs per allowed spawn of
   *  this kind and returns the session's behavior (DATA sink, RPC methods,
   *  teardown). Register before clients spawn; names are first-come. */
  registerKind(kind, handler) {
    if (kind === "shell" || this.kinds.has(kind))
      throw new Error(`kind already registered: ${kind}`);
    this.kinds.set(kind, handler);
    this.republish();
    return this;
  }
  // ------------------------------------------- service directory (D24/D25)
  /** Replace the embedder's half of the service directory and republish.
   *  Idempotent and cheap: the document is temp+renamed *only* when its
   *  content actually changes, and only then does `rev` move. fsiod calls
   *  this when the workspace registry changes — `fsio share` must reach a
   *  page without a daemon restart, the same "it bites at the next
   *  judgment" discipline D23 requires of revocation. */
  setServices(input) {
    this.servicesInput = input;
    this.republish();
    return this;
  }
  /** The document as this host would publish it right now (D24) — the
   *  introspection surface, and what the tests read. */
  services() {
    return { rev: this.servicesRev, ...this.buildServices() };
  }
  buildServices() {
    const shellServable = this.onSpawnRequest ? true : this.allowShell;
    const needsGrant = new Set(this.servicesInput.needsGrant ?? []);
    const named = [...this.kinds.keys(), ...shellServable ? ["shell"] : []];
    return canonServices({
      protocol: PROTOCOL_VERSION,
      capabilities: [
        ...shellServable ? [CAPABILITIES.SHELL] : [],
        ...this.ptyAvailable ? [CAPABILITIES.PTY] : [],
        CAPABILITIES.ATTACH,
        ...this.namedWorkspaces ? [CAPABILITIES.WORKSPACES] : [],
        ...this.servicesInput.capabilities ?? []
      ],
      kinds: named.map((name) => ({
        name,
        ...needsGrant.has(name) ? { needsGrant: true } : {},
        ...this.servicesInput.kindDetail?.[name] !== void 0 ? { detail: this.servicesInput.kindDetail[name] } : {}
      })),
      ...this.servicesInput.workspaces ? { workspaces: this.servicesInput.workspaces } : {},
      ...this.servicesInput.consent ? { consent: this.servicesInput.consent } : {}
    });
  }
  /** Write `services.json` if — and only if — its content changed, and ring
   *  the doorbell (`servicesRev` in `host.json`) when it did. Returns true
   *  on a revision bump. */
  publishServices() {
    const doc = this.buildServices();
    const body = JSON.stringify(doc);
    if (body === this.servicesBody)
      return false;
    let prev = this.servicesRev;
    if (this.servicesBody === null) {
      const onDisk = this.readServices();
      if (onDisk) {
        prev = Number.isFinite(onDisk.rev) && onDisk.rev > 0 ? Math.floor(onDisk.rev) : 0;
        const { rev: _rev, ...rest } = onDisk;
        if (JSON.stringify(canonServices(rest)) === body) {
          this.servicesBody = body;
          this.servicesRev = prev;
          return false;
        }
      }
    }
    this.servicesRev = prev + 1;
    this.servicesBody = body;
    writeJsonAtomic(path12.join(this.fsioDir, "services.json"), { rev: this.servicesRev, ...doc });
    return true;
  }
  readServices() {
    try {
      const parsed2 = JSON.parse(fs12.readFileSync(path12.join(this.fsioDir, "services.json"), "utf8"));
      return parsed2 && typeof parsed2 === "object" ? parsed2 : null;
    } catch {
      return null;
    }
  }
  // Republish + beat immediately: the heartbeat is the doorbell, and a
  // client that just learned a workspace exists should not wait out a beat
  // to hear about it. Costs a write only when something actually changed.
  republish() {
    if (this.running && this.publishServices())
      this.heartbeat();
  }
  /** Attach to the shared dir and begin serving. Resolves after the first
   *  heartbeat is on disk (host.json presence = readiness, per spec). */
  async start() {
    if (this.running)
      throw new Error("HostServer already started");
    this.refuseLiveHost();
    this.running = true;
    this.startedAt = now();
    this.ptyMod = this.ptyOpt === false ? null : this.ptyOpt ?? await loadPty();
    this.ptyAvailable = !!this.ptyMod;
    if (this.ptyMod)
      this.log.info("pty available: shell sessions get a real pty");
    else if (this.ptyOpt === false)
      this.log.info("pty disabled by the embedder: shell sessions would fall back to pipes");
    else
      this.log.warn("no pty (node-pty not installed): shell sessions fall back to pipes. `npm i node-pty` for full terminal support.");
    if (this.fresh)
      this.cleanServiceDir();
    fs12.mkdirSync(this.sessionsDir, { recursive: true });
    this.sweepTranscripts();
    this.ensureGitignore();
    const manifest = { protocol: PROTOCOL_VERSION };
    writeJsonAtomic(path12.join(this.fsioDir, "fsio.json"), manifest);
    this.publishServices();
    this.heartbeat();
    this.timers.push(setInterval(() => this.heartbeat(), this.timings.heartbeatMs));
    this.timers.push(setInterval(() => this.idleSweep(), this.timings.idleSweepMs));
    this.rootWatcher = this.watchDir(this.sessionsDir, () => this.scheduleScan());
    this.timers.push(setInterval(() => this.scheduleScan(), this.timings.safetyPollMs));
    if (this.pollMs > 0)
      this.timers.push(setInterval(() => this.scheduleScan(), this.pollMs));
    this.scheduleScan();
    return this;
  }
  /** Traffic gate for the hot poll (D4, ported host-side — F22). fs.watch
   *  wakeups ride FSEvents at ~50 ms on macOS (F2), too slow for a live
   *  uplink, so traffic arms a fast scan loop; `hotWindowMs` of silence
   *  disarms it and the per-dir watchers plus the 250 ms safety scan carry
   *  the idle case (invariant 1). The old gate was session *liveness*
   *  (`started && !done`), which is not the same claim: N idle-but-running
   *  sessions kept the 5 ms × O(N) loop hot forever — F22 measured ~60% of
   *  a core at 32 idle sessions, against ~3% for the same machinery
   *  idle-gated (cells A vs B), and ~10% vs ~0.6% at one. Wake-from-idle
   *  costs a watch event (~50 ms) or a safety scan (≤250 ms); the first
   *  consumed chunk re-arms the loop. */
  markActive() {
    this.lastTraffic = Date.now();
    if (this.hotTimer || this.hotPollMs <= 0 || !this.running)
      return;
    this.hotTimer = setInterval(() => {
      if (Date.now() - this.lastTraffic > this.timings.hotWindowMs) {
        clearInterval(this.hotTimer);
        this.hotTimer = null;
        return;
      }
      this.scheduleScan();
    }, this.hotPollMs);
  }
  /** Stop serving: kill session processes, release watchers and timers,
   *  retract host.json (peers read absence/staleness as host-gone). All of
   *  that happens synchronously — un-awaited calls still fully tear down.
   *  The returned promise resolves once every child has actually exited
   *  (SIGTERM, then SIGKILL after `timings.killGraceMs` — D14), so
   *  embedders can `await host.close()` for a clean process exit. */
  close() {
    if (!this.running)
      return Promise.resolve();
    this.running = false;
    const reaps = [];
    for (const s of this.sessions.values()) {
      const proc = s.proc;
      const usesPty = s.usesPty;
      s.close();
      this.archiveTranscript(s, "host closed");
      if (proc)
        reaps.push(this.reapChild(s.id, proc, usesPty));
    }
    for (const t of this.timers)
      clearInterval(t);
    this.timers = [];
    if (this.hotTimer)
      clearInterval(this.hotTimer);
    this.hotTimer = null;
    for (const t of this.pendingCleanups)
      clearTimeout(t);
    this.pendingCleanups.clear();
    this.rootWatcher?.close();
    this.rootWatcher = null;
    try {
      fs12.unlinkSync(path12.join(this.fsioDir, "host.json"));
    } catch {
    }
    return Promise.all(reaps).then(() => {
    });
  }
  // Wait for a killed child to actually exit; escalate to SIGKILL after the
  // grace period. Timers are unref'd and capped — close() can never hang a
  // process that wants to exit.
  reapChild(id, proc, usesPty) {
    return new Promise((resolve2) => {
      let settled = false;
      const done = () => {
        if (settled)
          return;
        settled = true;
        clearTimeout(escalate);
        clearTimeout(cap);
        resolve2();
      };
      if (usesPty)
        proc.onExit(done);
      else if (proc.exitCode !== null || proc.signalCode !== null)
        return done();
      else
        proc.once("exit", done);
      const grace = this.timings.killGraceMs;
      const escalate = setTimeout(() => {
        this.log.warn(`session ${id}: child ignored SIGTERM for ${grace}ms \u2014 SIGKILL`);
        try {
          if (usesPty)
            proc.kill("SIGKILL");
          else
            proc.kill("SIGKILL");
        } catch {
        }
      }, grace);
      const cap = setTimeout(done, grace * 2 + 1e3);
      escalate.unref?.();
      cap.unref?.();
    });
  }
  // ------------------------------------------------------------- internals
  // Mutual exclusion (#40): two live hosts on one .fsio would each spawn
  // every adopted session (double execution), both append out segments and
  // rewrite host-owned files (F8/D6: one writer per file), each consume
  // uplink chunks the other then sees as gaps — and both grant attach
  // requests (D18: dueling epoch bumps). Liveness is the same rule clients
  // use (spec: host.json mtime < 3 beats). A seatbelt, not a lock: two
  // hosts starting within one heartbeat can still collide (spec: Session
  // lifecycle), and `takeover` skips the refusal for a killed host whose
  // last beat hasn't gone stale yet.
  refuseLiveHost() {
    const hostJson = path12.join(this.fsioDir, "host.json");
    let ageMs;
    try {
      ageMs = Date.now() - fs12.statSync(hostJson).mtimeMs;
    } catch {
      return;
    }
    if (ageMs >= 3 * this.timings.heartbeatMs)
      return;
    const pid = readJson(hostJson)?.pid ?? "unknown";
    if (this.takeover) {
      this.log.warn(`taking over ${this.fsioDir} from a live-looking host (pid ${pid}, last heartbeat ${Math.round(ageMs)}ms ago)`);
      return;
    }
    throw new Error(`another fsio host looks live on ${this.fsioDir} (pid ${pid}, last heartbeat ${Math.round(ageMs)}ms ago). Stop it first, or pass takeover (--takeover) if it is a stale corpse.`);
  }
  // Scrollback hygiene (#82, spec: Scrollback hygiene): the out log is full
  // scrollback — secrets typed or echoed included — and must never reach
  // version control. When the shared directory lies inside a git repository
  // (a .git dir or file anywhere above it — worktrees use a file), ensure
  // `.fsio/` is ignored by appending to the shared dir's OWN .gitignore:
  // git honors one at every level, so this is correct for nested dirs and
  // never touches files outside the directory the user handed us. Failure
  // warns loudly (the user must add the line themselves) and never blocks
  // start().
  ensureGitignore() {
    if (!this.gitignore)
      return;
    let dir = this.sharedDir;
    for (; ; ) {
      if (fs12.existsSync(path12.join(dir, ".git")))
        break;
      const up = path12.dirname(dir);
      if (up === dir)
        return;
      dir = up;
    }
    const file = path12.join(this.sharedDir, ".gitignore");
    try {
      let text = "";
      try {
        text = fs12.readFileSync(file, "utf8");
      } catch {
      }
      if (text.split("\n").some((l) => /^\/?\.fsio\/?$/.test(l.trim())))
        return;
      const sep = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
      fs12.appendFileSync(file, `${sep}# fsio transport state \u2014 session scrollback lives here
.fsio/
`);
      this.log.info(`added .fsio/ to ${file} (scrollback must never be committed)`);
    } catch (e) {
      this.log.warn(`could not git-ignore .fsio/ (${errMsg2(e)}) \u2014 add ".fsio/" to ${file} yourself: session scrollback, secrets included, lives inside it`);
    }
  }
  watchDir(p, cb) {
    if (!this.watchEnabled)
      return null;
    try {
      const w = fs12.watch(p, cb);
      w.on("error", () => {
      });
      return w;
    } catch {
      return null;
    }
  }
  heartbeat() {
    const info = {
      pid: process.pid,
      protocol: PROTOCOL_VERSION,
      // With a policy hook the static boolean is meaningless; advertise
      // shells as askable so clients try and get the policy's real answer
      // (a coded 1004 with a reason) instead of self-censoring.
      allowShell: this.onSpawnRequest ? true : this.allowShell,
      pty: this.ptyAvailable,
      startedAt: this.startedAt,
      seq: this.hbSeq++,
      t: now(),
      // The hot pointer at the cold document (D24) — same split as out.sig
      // (D3). `allowShell`/`pty` stay for one-folder clients that predate
      // the service directory; hub clients read `capabilities`.
      servicesRev: this.servicesRev
    };
    writeJsonAtomic(path12.join(this.fsioDir, "host.json"), info);
  }
  idleSweep() {
    for (const s of this.sessions.values()) {
      if ((s.exited || s.done) && Date.now() - Math.max(s.lastActivity, s.lastClientSeen) > this.timings.staleGraceMs) {
        this.log.info(`session ${s.id}: terminal and client silent for ${Math.round(this.timings.staleGraceMs / 1e3)}s, removing`);
        s.close();
        this.removeSessionDir(s, "terminal, client gone");
        continue;
      }
      if (s.started && !s.done && s.spawn?.kind === "echo" && Date.now() - s.lastActivity > this.timings.idleGcMs) {
        this.log.info(`session ${s.id}: idle for ${Math.round(this.timings.idleGcMs / 1e3)}s, reaping`);
        s.close();
        this.removeSessionDir(s, "idle");
        continue;
      }
      if (s.approved && !s.done && !s.exited && s.heartbeatAware && Date.now() - s.lastClientSeen > this.timings.detachAfterMs) {
        if (s.spawn?.kind === "echo") {
          this.log.info(`session ${s.id}: client vanished (no heartbeat for ${Math.round(this.timings.detachAfterMs / 1e3)}s), reaping`);
          s.close();
          this.removeSessionDir(s, "client vanished");
        } else if (!s.detached) {
          this.log.info(`session ${s.id}: client vanished (no heartbeat for ${Math.round(this.timings.detachAfterMs / 1e3)}s), marking detached`);
          s.setDetached(true);
        }
      }
    }
    this.sweepClientDirs();
  }
  // Per-page reporter dirs (#39) accumulate one per page load in a
  // long-lived shared dir; the host owns .fsio cleanup (D6). Keep the
  // newest CLIENT_DIR_CAP; beyond that, remove only dirs untouched for
  // staleGraceMs — a live reporter flushes at least every 5 s, so a live
  // page's dir never looks stale.
  sweepClientDirs() {
    const root = path12.join(this.fsioDir, CLIENT_DIR);
    let entries;
    try {
      entries = fs12.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory())
        continue;
      try {
        const p = path12.join(root, e.name);
        let mtime2 = fs12.statSync(p).mtimeMs;
        try {
          mtime2 = Math.max(mtime2, fs12.statSync(path12.join(p, "report.json")).mtimeMs);
        } catch {
        }
        dirs.push({ name: e.name, mtime: mtime2 });
      } catch {
      }
    }
    if (dirs.length <= CLIENT_DIR_CAP)
      return;
    dirs.sort((a, b) => b.mtime - a.mtime);
    for (const d of dirs.slice(CLIENT_DIR_CAP)) {
      if (Date.now() - d.mtime < this.timings.staleGraceMs)
        continue;
      try {
        fs12.rmSync(path12.join(root, d.name), { recursive: true, force: true });
        this.log.info(`client dir ${d.name}: over cap (${CLIENT_DIR_CAP}) and stale, removed`);
      } catch {
      }
    }
  }
  // ---- ended-session transcripts (D26 rule 4, #119)
  //
  // Two lifetimes were living in one directory. The plumbing — `in/`,
  // doorbells, status.json, the profile a session ran under — means
  // nothing once the host that wrote it is gone, and sweeping it is right.
  // The out log of a session that carried a *conversation* is the only
  // copy of that conversation, and the same sweep was taking it: a 572 KB
  // agent session, recovered by hand from that file, was unrecoverable
  // minutes later because the helper had been stopped.
  //
  // The record gets its own directory rather than a flag on the session's.
  // A flag would have to be understood by adoption, the idle sweep, the
  // stale GC, `fresh`, and every reattach picker reading `listSessions()`
  // — five places that would each have to learn that a directory can be
  // a corpse. Moving the bytes out means nothing in `sessions/` changes
  // lifetime at all, and the only code that knows about retention is the
  // wipe (`cleanServiceDir`).
  //
  // What is kept is what retention already had (D26 rule 1): the segments
  // still on disk. For a conversation shorter than one rotation that is
  // all of it; past that it is the tail, and `meta.json` carries `gen` and
  // `total` so a reader can say so (#57) instead of rendering a suffix as
  // if it were the whole thing.
  archiveTranscript(s, why) {
    if (!this.transcripts)
      return;
    let logs;
    try {
      logs = fs12.readdirSync(s.dir).filter((n) => OUT_LOG_RE.test(n)).sort();
    } catch {
      return;
    }
    if (!logs.length)
      return;
    const dir = path12.join(this.transcriptsDir, s.id);
    try {
      fs12.mkdirSync(dir, { recursive: true });
      let bytes = 0;
      for (const name of logs) {
        const to = path12.join(dir, name);
        fs12.renameSync(path12.join(s.dir, name), to);
        bytes += fs12.statSync(to).size;
      }
      try {
        fs12.copyFileSync(path12.join(s.dir, "spawn.json"), path12.join(dir, "spawn.json"));
      } catch {
      }
      const st = readJson(path12.join(s.dir, "status.json"));
      const first = OUT_LOG_RE.exec(logs[0]);
      const meta = {
        id: s.id,
        kind: s.spawn ? s.spawn.kind ?? "echo" : null,
        ...s.spawn?.client ? { client: s.spawn.client } : {},
        ...s.spawn?.origin ? { origin: s.spawn.origin } : {},
        ended: now(),
        why,
        exitCode: st?.exitCode ?? null,
        gen: first ? Number(first[1]) : 0,
        total: s.outTotal,
        bytes
      };
      writeJsonAtomic(path12.join(dir, "meta.json"), meta);
      this.log.info(`session ${s.id}: transcript kept (${why}, ${bytes} B)`);
    } catch (e) {
      this.log.warn(`session ${s.id}: transcript not kept: ${errMsg2(e)}`);
      return;
    }
    this.sweepTranscripts();
  }
  /** Enforce the retention bounds, newest first. Runs after every archive
   *  and once at start — a cap lowered between runs takes effect then,
   *  which is the only moment it can: nothing sweeps while no host runs. */
  sweepTranscripts() {
    const cfg = this.transcripts;
    if (!cfg)
      return;
    let entries;
    try {
      entries = fs12.readdirSync(this.transcriptsDir, { withFileTypes: true });
    } catch {
      return;
    }
    const kept = [];
    for (const e of entries) {
      if (!e.isDirectory())
        continue;
      const dir = path12.join(this.transcriptsDir, e.name);
      let bytes = 0;
      let ended = 0;
      try {
        for (const f of fs12.readdirSync(dir))
          bytes += fs12.statSync(path12.join(dir, f)).size;
        ended = readJson(path12.join(dir, "meta.json"))?.ended ?? fs12.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      kept.push({ name: e.name, ended, bytes });
    }
    kept.sort((a, b) => b.ended - a.ended);
    let running = 0;
    for (let i = 0; i < kept.length; i++) {
      const t = kept[i];
      running += t.bytes;
      const over = i >= cfg.keep ? `over the ${cfg.keep}-transcript cap` : i > 0 && running > cfg.maxBytes ? `over the ${cfg.maxBytes} B cap` : null;
      if (!over)
        continue;
      try {
        fs12.rmSync(path12.join(this.transcriptsDir, t.name), { recursive: true, force: true });
        this.log.info(`transcript ${t.name}: removed (${over})`);
      } catch {
      }
    }
  }
  /** Delete the service directory, keeping what outlives the host that
   *  wrote it. `fresh: true` runs this at start; an embedder runs it at
   *  Ctrl-C — the two moments that used to `rm -rf .fsio` and take the
   *  transcripts with it (#119). With retention off and `keepClient` false
   *  it is exactly that `rm -rf`; otherwise the survivors below stay, and a
   *  `.fsio` left holding nothing removes itself so a folder that hosted no
   *  conversation is still handed back pristine (D6).
   *
   *  `keepClient` spares `client/`, which is the one directory under
   *  `.fsio` the host does not own: pages write their own diagnostics there
   *  and nothing in the protocol reads them (spec layout, D6's amendment
   *  for [#109](https://github.com/dglazkov/fsio/issues/109)). Sweeping it
   *  is the host cleaning up after a party it was not at — and in a
   *  manually-driven cooperative run it destroys the verdicts *as the
   *  gesture that ends the run*, which is how #102's first run lost them.
   *
   *  It is a parameter rather than a constant because the two call sites
   *  want opposite answers. At shutdown the reports are the point. At
   *  `fresh` start they are the previous run's, and carrying them forward
   *  would make "read the newest dir under `client/`" — the whole
   *  cooperative-verification contract — quietly unreliable. */
  cleanServiceDir(keepClient = false) {
    const keep = /* @__PURE__ */ new Set();
    if (this.transcripts)
      keep.add(path12.basename(this.transcriptsDir));
    if (keepClient)
      keep.add(CLIENT_DIR);
    let entries;
    try {
      entries = fs12.readdirSync(this.fsioDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (keep.has(e.name))
        continue;
      try {
        fs12.rmSync(path12.join(this.fsioDir, e.name), { recursive: true, force: true });
      } catch {
      }
    }
    try {
      fs12.rmdirSync(this.fsioDir);
    } catch {
    }
  }
  scheduleScan() {
    if (!this.running)
      return;
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.runScan();
  }
  runScan() {
    this.scanning = true;
    do {
      this.rescan = false;
      try {
        this.scanOnce();
      } catch (e) {
        this.log.error("scan error:", errMsg2(e));
      }
    } while (this.rescan);
    this.scanning = false;
  }
  scanOnce() {
    let entries;
    try {
      entries = fs12.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory())
        continue;
      if (!this.sessions.has(e.name))
        this.adoptSession(e.name);
    }
    for (const s of this.sessions.values()) {
      if (s.done)
        continue;
      if (!s.started)
        this.tryStart(s);
      if (s.approved)
        this.processIncoming(s);
      if (s.approved || s.exited)
        this.processAttach(s);
    }
  }
  adoptSession(id) {
    const s = new Session(this, id);
    this.sessions.set(id, s);
    const status = readJson(path12.join(s.dir, "status.json"));
    if (status && status.state === "exited") {
      s.done = true;
      if (now() - (status.t ?? 0) > this.timings.staleGraceMs)
        this.removeSessionDir(s, "stale");
      return;
    }
    s.watchers.push(this.watchDir(s.dir, () => this.scheduleScan()));
    this.markActive();
    this.log.info(`session ${id}: adopted`);
  }
  tryStart(s) {
    const raw = readJson(path12.join(s.dir, "spawn.json"));
    if (!raw)
      return;
    if (raw.jsonrpc === "2.0" && raw.method === "spawn") {
      s.spawn = raw.params ?? {};
      s.spawnId = raw.id ?? null;
    } else {
      s.spawn = raw;
    }
    const prior = readJson(path12.join(s.dir, "status.json"));
    if (prior?.writer)
      s.epoch = prior.writer.epoch;
    s.started = true;
    s.watchers.push(this.watchDir(s.inDir, () => this.scheduleScan()));
    const kind = s.spawn.kind ?? "echo";
    if (kind !== "shell" && !this.kinds.has(kind)) {
      const error = `unknown kind: ${kind}`;
      s.setStatus({ state: "error", error });
      s.spawnFail(RpcErrors.UNKNOWN_KIND, error);
      s.done = true;
      return;
    }
    const info = {
      sessionId: s.id,
      kind,
      client: s.spawn.client,
      origin: s.spawn.origin
    };
    if (kind === "shell") {
      const root = this.resolveWorkspace(s, info);
      if (root === null)
        return;
      s.root = root;
      Object.assign(info, this.resolveShell(s.spawn, root));
      if (!contains(root, info.cwd)) {
        const error = "cwd escapes the workspace root";
        s.setStatus({ state: "error", error });
        s.spawnFail(RpcErrors.INVALID_PARAMS, error);
        s.done = true;
        return;
      }
    }
    this.log.info(`session ${s.id}: spawn request kind=${kind}${info.origin ? ` origin=${info.origin}` : ""}${info.cmd ? ` cmd=${info.cmd}` : ""}`);
    void this.decideAndStart(s, kind, info);
  }
  // The default (static) policy — exactly the historical behavior: echo is
  // free, shell rides the allowShell boolean with the legacy 1001 code.
  defaultPolicy(info) {
    if (info.kind !== "shell" || this.allowShell)
      return true;
    return {
      allow: false,
      code: RpcErrors.SHELL_NOT_ALLOWED,
      reason: "shell sessions not allowed; start host with --allow-shell"
    };
  }
  // Consult the policy hook (or the static default), fail-safe. Shared by
  // spawn (D12) and attach (D18) — an attach is judged like a spawn of the
  // same kind, with the attacher's identity and `attach: true` in the info.
  async consultPolicy(s, spec, info) {
    let decision;
    try {
      decision = this.onSpawnRequest ? await this.onSpawnRequest(spec, info) : this.defaultPolicy(info);
    } catch (e) {
      this.log.error(`session ${s.id}: ${info.attach ? "attach" : "spawn"} policy threw (${errMsg2(e)}) \u2014 denying`);
      decision = { allow: false, reason: `${info.attach ? "attach" : "spawn"} policy failed` };
    }
    return typeof decision === "boolean" ? { allow: decision } : decision;
  }
  // Consult the spawn policy (D12), then dispatch. Async on purpose: a
  // promise-returning hook is the confirmation mechanism — the session sits
  // unanswered (spawn request pending, no incoming processed) until the
  // policy settles. Sessions that closed while deciding are dropped.
  async decideAndStart(s, kind, info) {
    const d = await this.consultPolicy(s, s.spawn, info);
    if (!this.running || s.done)
      return;
    if (!d.allow) {
      const error = d.reason ?? "spawn denied by host policy";
      this.log.info(`session ${s.id}: denied (${error})`);
      s.setStatus({ state: "error", error });
      s.spawnFail(d.code ?? RpcErrors.SPAWN_DENIED, error);
      s.done = true;
      return;
    }
    s.approved = true;
    this.log.info(`session ${s.id}: start kind=${kind}`);
    if (kind === "shell")
      this.startShell(s);
    else
      this.startKind(s, kind);
    this.scheduleScan();
  }
  // Start a registered kind (D13): run the handler (possibly async), then
  // answer the spawn request. Echo rides this path too — its handler is
  // the trivial `() => ({})`, so the registry mechanism is exercised on
  // every workbench bench run, not just by exotic embedders.
  startKind(s, kind) {
    const handler = this.kinds.get(kind);
    const ctx = {
      sessionId: s.id,
      spec: s.spawn ?? {},
      write: (data) => {
        if (s.done || !s.kindSession)
          return;
        s.appendFrame(FrameType.DATA, typeof data === "string" ? new TextEncoder().encode(data) : data);
      },
      exit: (exitCode = null) => {
        if (s.done || !s.kindSession)
          return;
        s.kindSession = null;
        s.exited = true;
        s.setStatus({ state: "exited", exitCode });
        this.log.info(`session ${s.id}: kind ${kind} exited (code ${exitCode})`);
      },
      log: {
        info: (...args) => this.log.info(`session ${s.id}:`, ...args),
        warn: (...args) => this.log.warn(`session ${s.id}:`, ...args),
        error: (...args) => this.log.error(`session ${s.id}:`, ...args)
      }
    };
    Promise.resolve().then(() => handler(ctx)).then((ks) => {
      if (s.done) {
        try {
          ks.onClose?.();
        } catch {
        }
        return;
      }
      s.kindSession = ks;
      s.setStatus({ state: "running", kind, pid: process.pid });
      s.spawnOk({ kind, pid: process.pid, ...ks.result });
      this.scheduleScan();
    }).catch((e) => {
      if (s.done)
        return;
      const error = `kind ${kind} failed to start: ${errMsg2(e)}`;
      s.setStatus({ state: "error", error });
      s.spawnFail(RpcErrors.SPAWN_FAILED, error);
      s.done = true;
    });
  }
  /** Hub deployment (D22): resolve the spec's `workspace` name to the root
   *  the child will run in, or refuse the session with `1006` and return
   *  null. `1006` covers unresolvable, may-not-see, and omitted-where-
   *  required alike — the client's next move (name a workspace it can
   *  have) is the same for all three. One-folder hosts have no resolver:
   *  the shared directory is the root, as it always was. */
  resolveWorkspace(s, info) {
    const asked = typeof s.spawn?.workspace === "string" ? s.spawn.workspace : void 0;
    const r = this.workspaces(asked, info);
    if ("error" in r) {
      this.log.info(`session ${s.id}: workspace refused (${r.error})`);
      s.setStatus({ state: "error", error: r.error });
      s.spawnFail(RpcErrors.UNKNOWN_WORKSPACE, r.error);
      s.done = true;
      return null;
    }
    const name = r.name ?? asked;
    if (name)
      info.workspace = s.workspace = name;
    return path12.resolve(r.root);
  }
  /** The exact thing a shell spec would run — shared by the policy hook's
   *  info and startShell so the judged command can't drift from the
   *  executed one (#6: "display the exact spawn.json before honoring it").
   *  `root` is the resolved workspace root (D22), or the shared directory
   *  in one-folder mode. */
  resolveShell(spec, root) {
    return {
      cmd: spec.cmd || process.env.SHELL || "/bin/bash",
      args: spec.args ?? [],
      cwd: spec.cwd ? path12.resolve(root, spec.cwd) : root,
      pty: !!this.ptyMod && spec.pty !== false
    };
  }
  startShell(s) {
    const spec = s.spawn;
    const { cmd, args: cmdArgs, cwd, pty: usePty } = this.resolveShell(spec, s.root ?? this.sharedDir);
    const cols = spec.cols ?? 80;
    const rows = spec.rows ?? 24;
    if (usePty) {
      try {
        const p = this.ptyMod.spawn(cmd, cmdArgs, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: process.env
        });
        s.proc = p;
        s.usesPty = true;
        p.onData((d) => {
          if (!s.done)
            s.appendFrame(FrameType.DATA, Buffer.from(d));
        });
        p.onExit(({ exitCode }) => {
          if (s.done)
            return;
          this.log.info(`session ${s.id}: exited code=${exitCode}`);
          s.exited = true;
          s.setStatus({ state: "exited", exitCode });
          s.proc = null;
        });
        s.setStatus({ state: "running", kind: "shell", pty: true, pid: p.pid, cmd });
        s.spawnOk({ kind: "shell", pty: true, pid: p.pid, cmd });
        return;
      } catch (e) {
        this.log.warn(`session ${s.id}: pty spawn failed (${errMsg2(e)}); falling back to pipes`);
      }
    }
    try {
      const p = cpSpawn(cmd, cmdArgs, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      p.on("spawn", () => s.spawnOk({ kind: "shell", pty: false, pid: p.pid, cmd }));
      p.on("error", (e) => {
        if (s.done)
          return;
        this.log.warn(`session ${s.id}: spawn error: ${e.message}`);
        s.setStatus({ state: "error", error: `could not start ${cmd}: ${e.message}` });
        s.spawnFail(RpcErrors.SPAWN_FAILED, `could not start ${cmd}: ${e.message}`);
        s.proc = null;
      });
      s.proc = p;
      s.usesPty = false;
      p.stdout.on("data", (d) => {
        if (!s.done)
          s.appendFrame(FrameType.DATA, d);
      });
      p.stderr.on("data", (d) => {
        if (!s.done)
          s.appendFrame(FrameType.DATA, d);
      });
      p.on("exit", (code) => {
        if (s.done)
          return;
        this.log.info(`session ${s.id}: exited code=${code}`);
        s.exited = true;
        s.setStatus({ state: "exited", exitCode: code });
        s.proc = null;
      });
      s.setStatus({ state: "running", kind: "shell", pty: false, pid: p.pid, cmd });
    } catch (e) {
      this.log.warn(`session ${s.id}: spawn failed: ${errMsg2(e)}`);
      s.setStatus({ state: "error", error: `could not start ${cmd}: ${errMsg2(e)}` });
      s.spawnFail(RpcErrors.SPAWN_FAILED, `could not start ${cmd}: ${errMsg2(e)}`);
      s.done = true;
    }
  }
  // Attach requests (D18): `attach.<aid>.json` in the session dir is the
  // bootstrap transport (like spawn.json — a would-be writer cannot ask on
  // an uplink it doesn't own yet). Deleting the file is the consumption
  // ack, done BEFORE deciding: a crash between delete and answer just
  // times the attacher out, and it retries with a fresh aid.
  processAttach(s) {
    let names;
    try {
      names = fs12.readdirSync(s.dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!/^attach\.[A-Za-z0-9_-]+\.json$/.test(name))
        continue;
      const p = path12.join(s.dir, name);
      const raw = readJson(p);
      try {
        fs12.unlinkSync(p);
      } catch {
        continue;
      }
      if (!raw) {
        this.log.warn(`session ${s.id}: discarding unparseable ${name}`);
        continue;
      }
      this.markActive();
      void this.decideAttach(s, raw);
    }
  }
  async decideAttach(s, msg) {
    const id = msg.id ?? null;
    const answer = (resp) => {
      if (id !== null && !s.done)
        s.appendJson(FrameType.RPC, resp);
    };
    const params = msg.params ?? {};
    const aid = typeof params.aid === "string" && params.aid.length > 0 ? params.aid : null;
    if (msg.method !== "attach" || !aid || id === null) {
      answer(rpcError(id, RpcErrors.INVALID_REQUEST, "malformed attach request"));
      return;
    }
    if (s.done || s.exited || !s.hasStatus) {
      answer(rpcError(id, RpcErrors.ATTACH_FAILED, s.exited ? "session exited" : "session not attachable"));
      return;
    }
    const kind = s.spawn?.kind ?? "echo";
    const info = {
      sessionId: s.id,
      kind,
      attach: true,
      client: params.client,
      origin: params.origin,
      // The workspace was resolved at spawn (D22) — an attach inherits the
      // subject it is taking over, it never re-picks one.
      ...s.workspace ? { workspace: s.workspace } : {},
      ...kind === "shell" ? this.resolveShell(s.spawn, s.root ?? this.sharedDir) : {}
    };
    this.log.info(`session ${s.id}: attach request from ${aid}${info.origin ? ` origin=${info.origin}` : ""}`);
    const d = await this.consultPolicy(s, s.spawn ?? {}, info);
    if (!this.running || s.done)
      return;
    if (!d.allow) {
      const reason = d.reason ?? "attach denied by host policy";
      this.log.info(`session ${s.id}: attach denied (${reason})`);
      answer(rpcError(id, d.code ?? RpcErrors.SPAWN_DENIED, reason));
      return;
    }
    if (s.exited) {
      answer(rpcError(id, RpcErrors.ATTACH_FAILED, "session exited"));
      return;
    }
    s.epoch += 1;
    s.nextInSeq = null;
    try {
      fs12.mkdirSync(s.inDir, { recursive: true });
    } catch {
    }
    s.watchers.push(this.watchDir(s.inDir, () => this.scheduleScan()));
    s.lastClientSeen = Date.now();
    s.detached = false;
    s.patchStatus({ writer: { epoch: s.epoch, aid } });
    const pid = s.proc ? s.proc.pid ?? process.pid : process.pid;
    const result = {
      kind,
      pid,
      epoch: s.epoch,
      ...kind === "shell" ? { pty: s.usesPty, cmd: this.resolveShell(s.spawn, s.root ?? this.sharedDir).cmd } : {}
    };
    this.log.info(`session ${s.id}: attach granted to ${aid} (epoch ${s.epoch})`);
    answer(rpcResult(id, result));
    this.scheduleScan();
  }
  // Consume in/ chunks strictly in sequence order. Two kinds share one
  // sequence space: NNNNNNNN.f files (payload = content) and
  // NNNNNNNN-<b64url> directories (payload = name; fast lane, F10).
  processIncoming(s) {
    let names;
    try {
      names = fs12.readdirSync(s.inDir);
    } catch {
      return;
    }
    const chunks = /* @__PURE__ */ new Map();
    for (const n of names) {
      let m;
      if (m = CHUNK_RE.exec(n))
        chunks.set(Number(m[1]), { name: n });
      else if (m = DIR_CHUNK_RE.exec(n))
        chunks.set(Number(m[1]), { name: n, data: m[2] });
    }
    if (chunks.size === 0)
      return;
    if (s.nextInSeq === null)
      s.nextInSeq = Math.min(...chunks.keys());
    while (chunks.has(s.nextInSeq)) {
      const chunk = chunks.get(s.nextInSeq);
      const p = path12.join(s.inDir, chunk.name);
      let bytes;
      if (chunk.data !== void 0) {
        bytes = b64urlDecode(chunk.data);
      } else {
        try {
          bytes = fs12.readFileSync(p);
        } catch {
          return;
        }
        if (bytes.length === 0) {
          s.scheduleRetry();
          return;
        }
      }
      const t1 = now();
      const { frames, consumed } = parseFrames(bytes);
      if (consumed < bytes.length || frames.length === 0) {
        s.scheduleRetry();
        return;
      }
      s.lastActivity = Date.now();
      s.lastClientSeen = Date.now();
      this.markActive();
      s.setDetached(false);
      for (const f of frames)
        this.handleFrame(s, f, t1);
      if (chunk.data !== void 0)
        fs12.rmdirSync(p);
      else
        fs12.unlinkSync(p);
      s.nextInSeq++;
    }
  }
  handleFrame(s, frame, t1) {
    switch (frame.type) {
      case FrameType.DATA: {
        if (s.kindSession?.onData) {
          try {
            s.kindSession.onData(frame.payload);
          } catch (e) {
            this.log.warn(`session ${s.id}: kind onData threw: ${errMsg2(e)}`);
          }
          break;
        }
        if (!s.proc)
          break;
        if (s.pty)
          s.pty.write(Buffer.from(frame.payload).toString("utf8"));
        else
          s.child.stdin.write(Buffer.from(frame.payload));
        break;
      }
      case FrameType.RPC: {
        let msg;
        try {
          msg = decodeJson(frame.payload);
        } catch (e) {
          s.appendJson(FrameType.RPC, rpcError(null, RpcErrors.PARSE_ERROR, `unparseable RPC frame: ${errMsg2(e)}`));
          break;
        }
        this.handleRpc(s, msg, t1);
        break;
      }
      default:
        this.log.warn(`session ${s.id}: ignoring frame type ${frameTypeName(frame.type)}`);
    }
  }
  // Control plane: JSON-RPC 2.0, one message per RPC frame (spec D10).
  // Requests get responses on the out stream; notifications are
  // fire-and-forget; responses from the client are not expected (the host
  // never sends requests in v0) and are ignored.
  handleRpc(s, msg, t1) {
    const { id, method, params = {} } = msg;
    if (method === void 0)
      return;
    const isRequest = id !== void 0;
    if (s.kindSession?.methods && method !== "ack" && method !== "close" && method !== "heartbeat" && method !== "detach") {
      const fn = s.kindSession.methods[method];
      if (fn) {
        Promise.resolve().then(() => fn(params)).then((result) => {
          if (isRequest && !s.done)
            s.appendJson(FrameType.RPC, rpcResult(id, result ?? null));
        }).catch((e) => {
          if (!isRequest || s.done)
            return;
          const code = typeof e?.code === "number" ? e.code : RpcErrors.INTERNAL_ERROR;
          const data = e?.data;
          s.appendJson(FrameType.RPC, rpcError(id, code, errMsg2(e), data));
        });
        return;
      }
    }
    switch (method) {
      case "ping": {
        const result = { t0: 0, ...params, t1, t2: now() };
        if (isRequest)
          s.appendJson(FrameType.RPC, rpcResult(id, result));
        break;
      }
      case "resize": {
        const { cols, rows } = params;
        s.pty?.resize(cols, rows);
        break;
      }
      case "ack":
        s.ack(params.total);
        break;
      case "heartbeat":
        s.heartbeatAware = true;
        break;
      case "detach":
        this.log.info(`session ${s.id}: detached by client`);
        s.setDetached(true);
        break;
      case "signal": {
        const { sig } = params;
        if (s.proc) {
          try {
            if (s.pty)
              s.pty.kill(sig);
            else
              s.child.kill(sig ?? "SIGTERM");
          } catch {
          }
        }
        break;
      }
      case "eof":
        s.child?.stdin?.end();
        break;
      case "close":
        this.log.info(`session ${s.id}: closed by client`);
        s.setStatus({ state: "exited", exitCode: null, closedByClient: true });
        s.close();
        {
          const t = setTimeout(() => {
            this.pendingCleanups.delete(t);
            this.removeSessionDir(s, "closed");
          }, this.timings.closeDelayMs);
          this.pendingCleanups.add(t);
        }
        break;
      default:
        if (isRequest)
          s.appendJson(FrameType.RPC, rpcError(id, RpcErrors.METHOD_NOT_FOUND, `unknown method: ${method}`));
        else
          this.log.warn(`session ${s.id}: unknown notification ${method}`);
    }
  }
  removeSessionDir(s, why) {
    try {
      this.archiveTranscript(s, why);
      fs12.rmSync(s.dir, { recursive: true, force: true });
      this.sessions.delete(s.id);
      this.log.info(`session ${s.id}: removed (${why})`);
    } catch (e) {
      this.log.warn(`session ${s.id}: cleanup failed: ${errMsg2(e)}`);
    }
  }
};

// dist/ask.js
import readline from "node:readline/promises";
import { describeGrant as describeGrant2, grantId as grantId3 } from "pewter";

// dist/shell.js
import fs13 from "node:fs";
import path13 from "node:path";
import { repoOfCwd } from "pewter";
var ShellError = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "ShellError";
  }
};
function planShell(p, spec, resolved) {
  const cwd = resolved.cwd ?? p.root;
  const asked = typeof spec["cwd"] === "string" ? spec["cwd"] : void 0;
  const repo = repoOfCwd(asked);
  let stat;
  try {
    stat = fs13.statSync(cwd);
  } catch {
    throw new ShellError(repo ? "no_repo" : "no_cwd", repo ? `no project named ${repo} in this pewter` : `${where3(p, cwd)} is not a directory in this pewter`, "a project is a directory under repos/ \u2014 `pewt repos` lists them");
  }
  if (!stat.isDirectory()) {
    throw new ShellError("no_cwd", `${where3(p, cwd)} is a file, and a shell needs a directory`);
  }
  return {
    cmd: resolved.cmd ?? process.env["SHELL"] ?? "/bin/bash",
    cwd,
    where: where3(p, cwd),
    // `--repo site` is the spelling both front ends offer, so it is the one
    // the question shows back. A spec written by hand can name any directory
    // in the folder, and that one says where instead of pretending to a flag
    // nobody typed.
    label: repo ? `shell --repo ${repo}` : cwd === p.root ? "shell" : `shell in ${where3(p, cwd)}/`,
    pty: resolved.pty !== false
  };
}
function where3(p, dir) {
  const rel = path13.relative(p.root, dir);
  return rel === "" ? p.name : rel;
}

// dist/ask.js
function terminalAsker() {
  if (!process.stdin.isTTY)
    return { ask: null };
  let queue = Promise.resolve();
  return {
    ask: (question) => {
      const next = queue.then(async () => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      });
      queue = next.catch(() => {
      });
      return next;
    }
  };
}
var stamp = () => (/* @__PURE__ */ new Date()).toTimeString().slice(0, 8);
var STARTS = { run: "--allow-runs", shell: "--allow-shells", agent: "--allow-agents", "repos.install": "--allow-runs" };
function spawnGate(p, opts, log) {
  const told = { run: opts.allowRuns, shell: opts.allowShells, agent: opts.allowAgents, "repos.install": opts.allowRuns };
  return async (spec, info) => {
    if (info.kind === "repos.clone") {
      log.info(`\u25CF repos.clone \u2014 git will fetch into repos/, executing nothing (${from(info.origin)})`);
      return true;
    }
    if (!(info.kind in STARTS)) {
      log.info(`\u25CF ${info.kind} session \u2014 origin: ${info.origin ?? "(none reported)"}`);
      return true;
    }
    const kind = info.kind;
    let plan;
    try {
      plan = kind === "run" ? runQuestion(p, spec) : kind === "shell" ? shellQuestion(p, spec, info) : kind === "agent" ? agentQuestion(p, spec) : installQuestion(p, spec);
    } catch (e) {
      const message = e instanceof RunError || e instanceof ShellError || e instanceof AgentError || e instanceof InstallError ? [e.message, e.hint].filter(Boolean).join(" \u2014 ") : e instanceof Error ? e.message : String(e);
      log.warn(`\u2717 ${message}`);
      return { allow: false, reason: message };
    }
    if (told[kind]) {
      log.info(`\u25B8 ${plan.label} \u2014 allowed by ${plan.flag} (${from(info.origin)})`);
      return true;
    }
    let standing;
    try {
      standing = plan.grant ? standingGrant(readGrants(p), plan.grant) : null;
    } catch (e) {
      const message = e instanceof GrantsError ? [e.message, e.hint].filter(Boolean).join(" \u2014 ") : e instanceof Error ? e.message : String(e);
      log.warn(`\u2717 ${message}`);
      return { allow: false, reason: message };
    }
    if (standing) {
      const t = stamp();
      log.info(`
${t}  ${header(plan, info.origin)}
${t}    \u2713 allowed \u2014 a standing grant: ${describeGrant2(standing)}
${t}      take it back with \`pewt grants revoke ${grantId3(standing)}\``);
      return true;
    }
    return askToStart(p, opts.asker, plan, info.origin, log);
  };
}
var from = (origin) => origin ? `from the page (${origin})` : "from a terminal";
var header = (plan, origin) => `\u25B8 ${plan.label}${" ".repeat(Math.max(1, 40 - plan.label.length))}${from(origin)}`;
function runQuestion(p, spec) {
  const asked = asRunSpec(spec);
  if (!asked)
    throw new RunError("bad_params", "a run needs a script name");
  const plan = planRun(p, asked);
  return {
    label: plan.label,
    lines: [`npm run ${plan.script}`, plan.declared, `cwd ${plan.where}/`],
    flag: STARTS.run,
    // The project, not the script: what you are being asked to trust is a
    // package.json you can read, and the next script in it is a line away.
    grant: { kind: "run", ...plan.repo !== void 0 ? { repo: plan.repo } : {} }
  };
}
function installQuestion(p, spec) {
  const asked = asInstallSpec(spec);
  if (!asked)
    throw new InstallError("bad_params", "an install needs a project name");
  const plan = planInstall(p, asked);
  return {
    label: plan.label,
    // The middle line is the whole reason this asks when a clone did not:
    // install is the first execution of what a clone fetched.
    lines: ["npm install", "runs this project's lifecycle scripts, and its dependencies' postinstalls", `cwd ${plan.where}/`],
    flag: STARTS["repos.install"],
    // The run grant, deliberately: answering `a` here records run/<project>,
    // and an existing run/<project> answers this question too.
    grant: { kind: "run", repo: plan.name }
  };
}
function shellQuestion(p, spec, info) {
  const plan = planShell(p, spec, info);
  return {
    label: plan.label,
    // A shell is not a command with a purpose you can read, so there is less
    // to show than a run has: the program, where it starts, and the one thing
    // a person cannot see from the outside — that nothing confines it.
    lines: [plan.cmd, `cwd ${plan.where}/`, plan.pty ? "a terminal, unconfined \u2014 it can do anything you can" : "no pty (node-pty missing): pipes, so no job control and no full-screen programs"],
    flag: STARTS.shell
  };
}
function agentQuestion(p, spec) {
  const plan = planAgent(p, asAgentSpec(spec));
  return {
    label: plan.label,
    lines: [
      `${plan.adapter.title}${plan.version ? ` ${plan.version}` : ""}`,
      `cwd ${plan.where}/`,
      // The one fact a person wants before saying yes to an agent, and the
      // reason the roster carries a measured column at all. A version nobody
      // measured says so here rather than in a footnote — this is the moment
      // the answer matters.
      plan.adapter.asks ? `it asks before it edits${plan.unmeasured ? ` (measured at ${plan.adapter.measured}, this is ${plan.version ?? "unknown"})` : ""}` : "it edits with its own hands \u2014 nothing will ask you again"
    ],
    flag: STARTS.agent,
    // The adapter as well as the project, unlike a run. The line above is the
    // whole content of this question, and a grant covering an adapter nobody
    // read that line about would answer a question nobody asked.
    grant: { kind: "agent", adapter: plan.adapter.name, ...plan.repo !== void 0 ? { repo: plan.repo } : {} }
  };
}
async function askToStart(p, asker, plan, origin, log) {
  const t = stamp();
  if (!asker.ask) {
    log.warn(`${t}  ${header(plan, origin)}
${t}    \u2717 denied \u2014 this host has no terminal to ask in`);
    return {
      allow: false,
      reason: `the host has no terminal to ask on, so it cannot allow a process; start it with \`pewt serve ${plan.flag}\` to answer yes to every one of these`
    };
  }
  const [first, ...rest] = plan.lines;
  const answer = (await asker.ask(`
${t}  ${header(plan, origin)}
${t}    ?   ${first}
` + rest.map((line) => `${t}        ${line}
`).join("") + // Three answers where there is something to remember, two where there
  // is not. Deny is the capital, so a bare Enter starts nothing.
  (plan.grant ? `${t}      allow once / allow always / deny  [o/a/D] ` : `${t}      allow once / deny  [y/N] `))).trim().toLowerCase();
  const always = answer === "a" || answer === "always";
  const once = answer === "o" || answer === "once" || answer === "y" || answer === "yes";
  if (always && !plan.grant) {
    const reason = "a shell has no standing grant \u2014 it is unconfined, so an `always` here would be `always, anything`";
    log.warn(`${stamp()}    \u2717 denied \u2014 ${plan.label}
${stamp()}      ${reason}`);
    return { allow: false, reason };
  }
  if (always) {
    let recorded;
    try {
      recorded = recordGrant(p, plan.grant);
    } catch (e) {
      const why = e instanceof GrantsError ? [e.message, e.hint].filter(Boolean).join(" \u2014 ") : e instanceof Error ? e.message : String(e);
      log.warn(`${stamp()}    \u2713 allowed once \u2014 ${plan.label}
${stamp()}      but not remembered: ${why}`);
      return { allow: true };
    }
    log.info(`${stamp()}    \u2713 standing grant ${recorded.already ? "already recorded in" : "recorded \u2192"} ${GRANTS_FILE}
${stamp()}      ${describeGrant2(recorded.grant)} \u2014 take it back with \`pewt grants revoke ${grantId3(recorded.grant)}\``);
    return { allow: true };
  }
  log.info(`${stamp()}    ${once ? "\u2713 allowed once" : "\u2717 denied"} \u2014 ${plan.label}`);
  return once ? { allow: true } : { allow: false, reason: "denied at the host's terminal" };
}

// dist/kind.js
import { asReceipt, encodeControl } from "pewter";

// dist/router.js
import { command } from "pewter";
var PageError = class extends Error {
  reason;
  hint;
  constructor(reason, message, hint) {
    super(message);
    this.reason = reason;
    this.hint = hint;
    this.name = "PageError";
  }
};
var PageRefusal = class extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "PageRefusal";
  }
};
var COMMAND_TIMEOUT_MS = 15e3;
var Router = class {
  #page = null;
  #pending = /* @__PURE__ */ new Map();
  #seq = 0;
  get pageId() {
    return this.#page?.id ?? null;
  }
  /** Whether a page is listening. The `pewt` session's spawn result carries
   *  this, so a command line learns there is nobody to ask before it asks. */
  get attached() {
    return this.#page !== null;
  }
  /** Newest page wins. A pewter is one folder and one shell; a second page on
   *  the same folder is usually the first one reloaded, and the displaced
   *  session is about to close anyway. The commands waiting on it fail now
   *  rather than at their timeout, because the party that was going to answer
   *  them is gone. */
  attachPage(port) {
    const old = this.#page;
    this.#page = port;
    if (old && old.id !== port.id) {
      this.#failAll(new PageError("page_gone", `page ${old.id} was displaced by ${port.id}`));
      return { displaced: old.id };
    }
    return { displaced: null };
  }
  /** Only the current page detaching means anything; a displaced page closing
   *  later must not clear its successor. */
  detachPage(id) {
    if (this.#page?.id !== id)
      return false;
    this.#page = null;
    this.#failAll(new PageError("page_gone", "the page closed before answering"));
    return true;
  }
  /** Send one command to the page and wait for its receipt.
   *
   *  Rejects with PageError when the channel failed and with PageRefusal when
   *  the page said no. A caller reports those differently: one is "open the
   *  page", the other is "that tab does not exist". */
  dispatch(method, params, timeoutMs = COMMAND_TIMEOUT_MS) {
    const page = this.#page;
    if (!page) {
      return Promise.reject(new PageError("no_page", "no page is open on this pewter", "open the shell in a Chromium browser, drop this folder on it, and allow it"));
    }
    const id = `c${(++this.#seq).toString(36)}`;
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new PageError(
          "timeout",
          `the page did not answer within ${timeoutMs}ms`,
          // Both readings are live and nothing here can tell them apart: a
          // page that died without closing its session still looks attached,
          // and a page in a background tab is genuinely just slow (F16).
          "the tab may be in the background \u2014 browsers clamp those to about one timer a minute \u2014 or it may have gone without closing its session"
        ));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve2, reject, timer });
      try {
        page.send(command(id, method, params));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new PageError("page_gone", e instanceof Error ? e.message : String(e)));
      }
    });
  }
  /** A receipt arrived from the page. Returns false for one nobody is waiting
   *  on — a duplicate, or one that beat a timeout. Legal, and worth a log
   *  line, never an error. */
  receipt(msg) {
    const pending = this.#pending.get(msg.id);
    if (!pending)
      return false;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok)
      pending.resolve(msg.result);
    else
      pending.reject(new PageRefusal(msg.error.code, msg.error.message, msg.error.hint));
    return true;
  }
  /** Host shutdown: nothing is going to be answered now. */
  close() {
    this.#page = null;
    this.#failAll(new PageError("page_gone", "the host is shutting down"));
  }
  #failAll(err) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }
};

// dist/kind.js
function pewtKind(p, router, log) {
  const methods = {};
  for (const op2 of OPERATIONS) {
    methods[op2.method] = async (params) => {
      try {
        const checked = op2.parse(params);
        const result = hostAnswers(op2) ? await op2.run(p, checked) : await router.dispatch(op2.method, checked);
        log.info(`${op2.method} \u2192 ok`);
        return result;
      } catch (e) {
        throw asRpcError(e, op2.method, log);
      }
    };
  }
  return (ctx) => {
    const isPage = ctx.spec["page"] === true;
    if (!isPage) {
      log.info(`\u25CF client attached (${ctx.sessionId}) \u2014 ${String(ctx.spec["client"] ?? "unnamed")}`);
      return { result: spawnResult(), methods, onClose: () => log.info(`\u25CB client detached (${ctx.sessionId})`) };
    }
    const { displaced } = router.attachPage({ id: ctx.sessionId, send: (msg) => ctx.write(encodeControl(msg)) });
    if (displaced)
      log.warn(`page ${ctx.sessionId} took over from ${displaced}`);
    log.info(`\u25CF page attached (${ctx.sessionId}) \u2014 tab commands will be delivered here`);
    return {
      result: { ...spawnResult(), page: true, displaced },
      methods,
      onData: (bytes) => {
        const msg = asReceipt(bytes);
        if (!msg)
          return void log.warn("dropped an unreadable frame from the page");
        if (!router.receipt(msg))
          log.warn(`receipt ${msg.id} matched no waiting command`);
      },
      onClose: () => {
        if (router.detachPage(ctx.sessionId))
          log.info(`\u25CB page detached (${ctx.sessionId})`);
      }
    };
  };
  function spawnResult() {
    return { pewter: p.name, operations: OPERATIONS.map((o) => o.method), page: router.attached };
  }
}
function asRpcError(e, method, log) {
  if (e instanceof OpError) {
    log.warn(`${method} \u2192 ${e.code}`);
    return new RpcError(e.code === "bad_params" || e.code === "usage" ? RpcErrors.INVALID_PARAMS : RpcErrors.INTERNAL_ERROR, e.message, { code: e.code, ...e.hint ? { hint: e.hint } : {} });
  }
  if (e instanceof PageRefusal) {
    log.warn(`${method} \u2192 ${e.code} (from the page)`);
    return new RpcError(RpcErrors.INTERNAL_ERROR, e.message, { code: e.code, ...e.hint ? { hint: e.hint } : {} });
  }
  if (e instanceof PageError) {
    log.warn(`${method} \u2192 ${e.reason}`);
    return new RpcError(RpcErrors.INTERNAL_ERROR, e.message, { code: e.reason, ...e.hint ? { hint: e.hint } : {} });
  }
  return e;
}

// dist/open.js
import { execFile as execFile3 } from "node:child_process";
import fs14 from "node:fs";
import path14 from "node:path";
var CHROMIUMS = [
  { id: "com.google.Chrome", name: "Google Chrome" },
  { id: "com.microsoft.edgemac", name: "Microsoft Edge" },
  { id: "com.brave.Browser", name: "Brave" },
  { id: "org.chromium.Chromium", name: "Chromium" }
];
async function openInChromium(url, platform = process.platform) {
  if (platform !== "darwin") {
    return { opened: false, why: `opening a browser is only wired up on macOS (this is ${platform})` };
  }
  for (const b of CHROMIUMS) {
    const ok = await new Promise((resolve2) => {
      execFile3("open", ["-b", b.id, url], { timeout: 1e4 }, (err) => resolve2(!err));
    });
    if (ok)
      return { opened: true, browser: b.name };
  }
  return { opened: false, why: `no Chromium browser found (looked for ${CHROMIUMS.map((b) => b.name).join(", ")})` };
}
function hasClientDirs(fsioDir) {
  try {
    return fs14.readdirSync(path14.join(fsioDir, "client"), { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    return false;
  }
}
async function pageIsWatching(fsioDir, ms = 3500, stepMs = 250) {
  const until = Date.now() + ms;
  for (; ; ) {
    if (hasClientDirs(fsioDir))
      return true;
    if (Date.now() >= until)
      return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// dist/serve.js
var DEFAULT_SHELL = "http://localhost:8769";
async function serve(p, opts = {}) {
  const log = opts.log ?? console;
  const base = opts.url ?? process.env["PEWT_SHELL"] ?? DEFAULT_SHELL;
  let page;
  try {
    page = new URL(base);
  } catch {
    throw new Error(`--url ${JSON.stringify(base)} is not a URL`);
  }
  page.searchParams.set("dir", p.name);
  const tmpReal = fs15.realpathSync(os2.tmpdir());
  if (p.root.startsWith("/private/tmp") || p.root.startsWith(tmpReal)) {
    throw new Error(`refusing to serve a pewter under a temp dir (${p.root}) \u2014 Chrome's file observers break there (F9)`);
  }
  ensureState(p);
  const folderHasSeenAPage = hasClientDirs(p.fsio);
  const asker = opts.asker ?? terminalAsker();
  const router = new Router();
  const server = new HostServer({
    root: p.root,
    fresh: true,
    onSpawnRequest: spawnGate(p, {
      asker,
      ...opts.allowRuns !== void 0 ? { allowRuns: opts.allowRuns } : {},
      ...opts.allowShells !== void 0 ? { allowShells: opts.allowShells } : {},
      ...opts.allowAgents !== void 0 ? { allowAgents: opts.allowAgents } : {}
    }, log),
    logger: log
  });
  server.registerKind("pewt", pewtKind(p, router, log));
  server.registerKind("run", runKind(p, log));
  server.registerKind("agent", agentKind(p, log));
  server.registerKind("repos.clone", cloneKind(p, log));
  server.registerKind("repos.install", installKind(p, log));
  await server.start();
  console.log(`
pewter \xB7 ${p.root}
  ${countExtensions(p)}

  in the page: pick this folder \u2014 ${p.name} \u2014 and allow it. Those clicks are
  Chrome's own and cannot be automated (F15); they are also what stops the
  page from reaching anything you did not choose.

  from a terminal, in this folder:  pewt repos

  ${runPolicy(p, opts, asker)}

(Ctrl-C stops the host and sweeps .fsio)
`);
  console.log(`  ${page.href}
`);
  if (opts.open === false) {
    console.log("--no-open: opening nothing. Paste that into a Chromium browser.\n");
  } else if (folderHasSeenAPage && await pageIsWatching(p.fsio)) {
    console.log("a page is already open on this pewter \u2014 not opening another tab.\n");
  } else {
    const res = await openInChromium(page.href);
    console.log(res.opened ? `opened in ${res.browser}.
` : `${res.why} \u2014 open that URL yourself, in Chrome or another Chromium.
`);
  }
  return server;
}
function runPolicy(p, opts, asker) {
  const standing = grantLine(p);
  if (!asker.ask) {
    const told = [opts.allowRuns ? "runs" : null, opts.allowShells ? "shells" : null, opts.allowAgents ? "agents" : null].filter(Boolean);
    const list = told.length > 1 ? `${told.slice(0, -1).join(", ")} and ${told[told.length - 1]}` : told[0];
    const cannot = list ? `this host has no terminal to ask in. It allows ${list} because it was told to in advance, and denies everything else.` : "this host has no terminal to ask in, so it denies every run, shell and agent. Restart it with --allow-runs, --allow-shells or --allow-agents to allow them.";
    return standing ? `${cannot}
  ${standing}` : cannot;
  }
  const runs = opts.allowRuns ? "--allow-runs: every `pewt run` starts without asking." : "a `pewt run` asks here first, and starts nothing until you answer.";
  const shells = opts.allowShells ? "--allow-shells: every `pewt shell` starts without asking." : "a `pewt shell` asks here too, and what it starts is unconfined.";
  const agents = opts.allowAgents ? "--allow-agents: every `pewt agent` starts without asking." : "a `pewt agent` asks here too, and that question says whether the agent will ask you back.";
  return [runs, shells, agents, ...standing ? [standing] : []].join("\n  ");
}
function grantLine(p) {
  let grants;
  try {
    grants = readGrants(p);
  } catch (e) {
    return `${GRANTS_FILE} cannot be read (${e instanceof Error ? e.message : String(e)}), so nothing will start until it is fixed or deleted.`;
  }
  if (grants.length === 0)
    return null;
  return `${grants.length} standing grant${grants.length === 1 ? "" : "s"} \u2014 these start without asking. \`pewt grants\` lists them.`;
}
function countExtensions(p) {
  let names;
  try {
    names = fs15.readdirSync(p.extensions, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return "no extensions/ directory \u2014 the page will have nothing to show.";
  }
  return names.length ? `extensions: ${names.join(", ")}` : "extensions/ is empty \u2014 the page will have nothing to show.";
}
async function stop(server, p, signal) {
  console.log(`
${signal} \u2014 closing sessions\u2026`);
  await server.close();
  server.cleanServiceDir(true);
  const clientDir = path15.join(p.fsio, "client");
  const reports = fs15.existsSync(clientDir) ? fs15.readdirSync(clientDir).length : 0;
  console.log(reports ? `done; .fsio swept, ${reports} page report${reports === 1 ? "" : "s"} kept.` : "done; .fsio removed.");
}

// dist/terminal.js
function sizeOf(output) {
  return output.isTTY ? { cols: output.columns, rows: output.rows } : {};
}
async function attachTerminal(dir, spec, streams, opts = {}) {
  const { input, output } = streams;
  const shell = await shellOnHost(dir, spec, {
    onData: (chunk) => output.write(chunk),
    ...opts.onWaiting ? { onWaiting: opts.onWaiting } : {}
  });
  const raw = input.isTTY;
  const onInput = (data) => shell.write(data);
  const onResize = () => {
    if (output.isTTY)
      shell.resize(output.columns, output.rows);
  };
  const onEnd = () => shell.write("");
  try {
    if (raw)
      input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onInput);
    input.on("end", onEnd);
    if (output.isTTY)
      process.on("SIGWINCH", onResize);
    return await shell.exit;
  } finally {
    input.off("data", onInput);
    input.off("end", onEnd);
    process.off("SIGWINCH", onResize);
    if (raw)
      input.setRawMode(false);
    input.pause();
  }
}

// dist/cli.js
var parsed = parseArgs(process.argv.slice(2));
if (parsed.kind === "help") {
  console.log(parsed.text);
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(`pewt: ${parsed.message}

Run \`pewt --help\` for usage.`);
  process.exit(2);
}
var pewter = (() => {
  try {
    return findPewter(parsed.dir ?? process.cwd());
  } catch (e) {
    if (!(e instanceof NotAPewter))
      throw e;
    console.error(`pewt: ${e.message} (${e.dir})`);
    if (e.hint)
      console.error(`  ${e.hint}`);
    process.exit(2);
  }
})();
if (parsed.kind === "check") {
  try {
    const result = await check(pewter);
    console.log(parsed.json ? JSON.stringify(result, null, 2) : render(result));
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    if (!(e instanceof CheckError))
      throw e;
    if (parsed.json) {
      console.log(JSON.stringify({ reason: "cannot_check", code: e.code, message: e.message, hint: e.hint }, null, 2));
    } else {
      console.error(`pewt: ${e.message}`);
      if (e.hint)
        console.error(`  ${e.hint}`);
    }
    process.exit(2);
  }
} else if (parsed.kind === "serve") {
  const server = await serve(pewter, {
    ...parsed.url ? { url: parsed.url } : {},
    open: parsed.open,
    allowRuns: parsed.allowRuns,
    allowShells: parsed.allowShells,
    allowAgents: parsed.allowAgents
  }).catch((e) => {
    console.error(`pewt: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
  let closing = false;
  const shutdown = (signal) => {
    if (closing)
      return;
    closing = true;
    void stop(server, pewter, signal).then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} else if (parsed.kind === "process") {
  if (parsed.dryRun) {
    if (parsed.method === "agent") {
      try {
        const plan = planAgent(pewter, parsed.spec);
        console.log(parsed.json ? JSON.stringify({ dryRun: true, agent: plan.adapter.name, version: plan.version, asks: plan.adapter.asks, unmeasured: plan.unmeasured, where: plan.where }, null, 2) : `would start  ${plan.adapter.title}${plan.version ? ` ${plan.version}` : ""}
         cwd  ${plan.where}/
              ${plan.adapter.asks ? "it asks before it edits" : "it edits with its own hands"}

(nothing started \u2014 the host was not asked)`);
        process.exit(0);
      } catch (e) {
        if (!(e instanceof AgentError))
          throw e;
        console.error(`pewt: ${e.message}`);
        if (e.hint)
          console.error(`  ${e.hint}`);
        process.exit(1);
      }
    }
    if (parsed.method === "shell") {
      const cwd = typeof parsed.spec["cwd"] === "string" ? parsed.spec["cwd"] : ".";
      const where4 = path16.join(pewter.name, cwd);
      console.log(parsed.json ? JSON.stringify({ dryRun: true, cwd, where: where4 }, null, 2) : `would open  a shell
       cwd  ${where4}/

(nothing started \u2014 the host was not asked, and which shell it runs is its own)`);
      process.exit(0);
    }
    if (parsed.method === "repos.install") {
      try {
        const plan = planInstall(pewter, parsed.spec);
        console.log(parsed.json ? JSON.stringify({ dryRun: true, name: plan.name, where: plan.where }, null, 2) : `would run  npm install
      cwd  ${plan.where}/

(nothing started \u2014 the host asks first: an install runs lifecycle scripts)`);
        process.exit(0);
      } catch (e) {
        if (!(e instanceof InstallError))
          throw e;
        console.error(`pewt: ${e.message}`);
        if (e.hint)
          console.error(`  ${e.hint}`);
        process.exit(1);
      }
    }
    if (parsed.method === "repos.clone") {
      try {
        const plan = planClone(pewter, parsed.spec);
        console.log(parsed.json ? JSON.stringify({ dryRun: true, url: plan.url, name: plan.name, where: plan.where }, null, 2) : `would clone  ${plan.url}
       into  ${plan.where}/

(nothing started \u2014 and nothing would be asked: a clone fetches and executes nothing)`);
        process.exit(0);
      } catch (e) {
        if (!(e instanceof CloneError))
          throw e;
        console.error(`pewt: ${e.message}`);
        if (e.hint)
          console.error(`  ${e.hint}`);
        process.exit(1);
      }
    }
    try {
      const plan = planRun(pewter, parsed.spec);
      console.log(parsed.json ? JSON.stringify({ dryRun: true, ...plan }, null, 2) : `would run  npm run ${plan.script}
  declared  ${plan.declared}
       cwd  ${plan.where}/

(nothing started \u2014 the host was not asked)`);
      process.exit(0);
    } catch (e) {
      if (!(e instanceof RunError))
        throw e;
      console.error(`pewt: ${e.message}`);
      if (e.hint)
        console.error(`  ${e.hint}`);
      process.exit(1);
    }
  }
  if (parsed.method === "agent") {
    if (parsed.json) {
      console.error("pewt: agent has no --json \u2014 every line it prints is already one JSON message");
      process.exit(2);
    }
    try {
      const outcome = await pipeAgent(new NodeDirectory(pewter.root), parsed.spec, { input: process.stdin, output: process.stdout, errors: process.stderr }, { onWaiting: () => process.stderr.write("pewt: waiting for the host to allow this agent \u2014 it is asking on its own terminal\n") });
      if (outcome.ended === "host_gone") {
        process.stderr.write("pewt: the host stopped, and the agent stopped with it\n");
        process.exit(3);
      }
      process.exit(outcome.exitCode ?? 1);
    } catch (e) {
      const err = e instanceof CallError ? e : null;
      console.error(`pewt: ${err ? err.message : e instanceof Error ? e.message : String(e)}`);
      if (err?.hint)
        console.error(`  ${err.hint}`);
      process.exit(err?.reason === "refused" ? 1 : 3);
    }
  }
  if (parsed.method === "shell") {
    if (parsed.json) {
      console.error("pewt: shell has no --json \u2014 what it produces is a terminal, not a result");
      process.exit(2);
    }
    try {
      const outcome = await attachTerminal(new NodeDirectory(pewter.root), { ...parsed.spec, ...sizeOf(process.stdout) }, { input: process.stdin, output: process.stdout }, { onWaiting: () => process.stderr.write("pewt: waiting for the host to allow this shell \u2014 it is asking on its own terminal\n") });
      if (outcome.ended === "host_gone") {
        process.stderr.write("pewt: the host stopped, and the shell stopped with it\n");
        process.exit(3);
      }
      process.exit(outcome.exitCode ?? 1);
    } catch (e) {
      const err = e instanceof CallError ? e : null;
      console.error(`pewt: ${err ? err.message : e instanceof Error ? e.message : String(e)}`);
      if (err?.hint)
        console.error(`  ${err.hint}`);
      process.exit(err?.reason === "refused" ? 1 : 3);
    }
  }
  try {
    const outcome = await runOnHost(new NodeDirectory(pewter.root), parsed.method, parsed.spec, {
      onLine: (line, stream) => {
        const text = parsed.json ? JSON.stringify(stream === "out" ? { o: line } : { e: line }) : line;
        (stream === "out" || parsed.json ? process.stdout : process.stderr).write(`${text}
`);
      },
      onWaiting: () => process.stderr.write(parsed.method === "repos.clone" ? "pewt: waiting for the host to start this clone\n" : parsed.method === "repos.install" ? "pewt: waiting for the host to allow this install \u2014 it is asking on its own terminal\n" : "pewt: waiting for the host to allow this run \u2014 it is asking on its own terminal\n")
    });
    if (parsed.json)
      console.log(JSON.stringify({ end: outcome.exitCode }));
    if (outcome.ended === "host_gone") {
      process.stderr.write("pewt: the host stopped before the run finished; anything it started stopped with it\n");
      process.exit(outcome.exitCode ?? 3);
    }
    process.exit(outcome.exitCode ?? 1);
  } catch (e) {
    const err = e instanceof CallError ? e : null;
    const message = err ? err.message : e instanceof Error ? e.message : String(e);
    if (parsed.json) {
      console.log(JSON.stringify({ reason: err?.reason ?? "internal", code: err?.code, message, hint: err?.hint }, null, 2));
    } else {
      console.error(`pewt: ${message}`);
      if (err?.hint)
        console.error(`  ${err.hint}`);
    }
    process.exit(err?.reason === "refused" ? 1 : 3);
  }
} else {
  const op2 = byMethod(parsed.method);
  if (parsed.method === "files.open" || parsed.method === "files.fling") {
    const typed = parsed.params.path;
    const where4 = inPewter(typed, pewter.root, process.cwd());
    if ("outside" in where4) {
      console.error(`pewt: ${where4.outside} is outside ${pewter.name}/, so this page cannot read it`);
      console.error(`  The page's reach is exactly the folder you granted it, and neither open nor fling moves bytes across that edge.`);
      process.exit(2);
    }
    parsed.params = { ...parsed.params, path: where4.path };
  }
  try {
    const result = await call(new NodeDirectory(pewter.root), parsed.method, parsed.params);
    console.log(parsed.json ? JSON.stringify(result, null, 2) : op2.render(result));
    process.exit(0);
  } catch (e) {
    const err = e instanceof CallError ? e : null;
    const message = err ? err.message : e instanceof Error ? e.message : String(e);
    if (parsed.json) {
      console.log(JSON.stringify({ reason: err?.reason ?? "internal", code: err?.code, message, hint: err?.hint }, null, 2));
    } else {
      console.error(`pewt: ${message}`);
      if (err?.hint)
        console.error(`  ${err.hint}`);
    }
    process.exit(err?.reason === "refused" ? 1 : err?.reason === "no_page" ? 4 : 3);
  }
}
