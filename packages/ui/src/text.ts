// Strings both pages had to make: what to call a session, and how to say how
// long, how big, how long ago. No DOM, no Lit — this is the module the
// node-side tests import.

const ADJ = [
  "amber", "brisk", "calm", "clever", "coral", "dusty", "eager", "fuzzy",
  "gentle", "hazy", "ivory", "jolly", "keen", "lucky", "mellow", "nimble",
  "olive", "plucky", "quiet", "rusty", "sable", "tidy", "umber", "vivid",
  "warm", "witty", "young", "zesty", "azure", "bold", "crisp", "deft",
];

const ANIMAL = [
  "otter", "heron", "lynx", "moth", "raven", "shrew", "tapir", "vole",
  "wren", "yak", "bison", "crane", "dingo", "egret", "finch", "gecko",
  "ibis", "koala", "lemur", "marten", "newt", "osprey", "puffin", "quail",
  "robin", "stoat", "toad", "urchin", "viper", "walrus", "civet", "zebu",
];

/** A name for a session, hashed from its id.
 *
 *  `s-ms6nbc5y-2jyn3j` matches nothing else a person sees. An adjective-animal
 *  name laid over the id buys two properties, and both are why this is a hash
 *  rather than a counter. Every page derives the SAME name for the same
 *  session with no coordination, so "amber-otter" here is "amber-otter" in the
 *  window that took it over and in the list of a browser that has never seen
 *  it — which is what makes takeover (D18) legible. And it survives the
 *  session: a transcript is keyed by the same id, so a conversation keeps its
 *  name after it ends.
 *
 *  It deliberately claims nothing about what the session is *about*. Deriving
 *  that from the first prompt was the alternative, and it is a guess that is
 *  wrong whenever the opening prompt is not the subject.
 *
 *  Raw ids stay in tooltips and the reporter. */
export function friendlyName(sessionId: string): string {
  // FNV-1a, split into two 5-bit picks — 1024 names, plenty for a demo's
  // handful of concurrent sessions in one folder.
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${ADJ[h & 31]}-${ANIMAL[(h >>> 5) & 31]}`;
}

/** How long something has been running, for a row a human is choosing from. */
export function sinceLabel(started: number | null, now: number): string {
  if (started === null) return "start time unknown";
  const s = Math.max(0, Math.round((now - started) / 1000));
  if (s < 45) return "started just now";
  const plural = (n: number, unit: string): string => `started ${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (s < 5400) return plural(Math.max(1, Math.round(s / 60)), "minute");
  if (s < 172800) return plural(Math.round(s / 3600), "hour");
  return plural(Math.round(s / 86400), "day");
}

/** An elapsed span, at a glance: `12s`, `4m`, `3h`, `2d`. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** A byte count, at a glance. */
export function sizeOf(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
