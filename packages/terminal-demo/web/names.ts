// Friendly session names (#34 review nit): `s-ms6nbc5y-2jyn3j` matches
// nothing else the user sees — inside baseball. Layer a deterministic
// adjective-animal name over the id instead: hashed from the session id, so
// every tab, window, and picker row derives the SAME name for the same
// session with no coordination — which is what makes the takeover story
// legible ("amber-otter" here is "amber-otter" there). Raw ids stay in
// tooltips and the reporter.

const ADJ = [
  "amber", "brisk", "calm", "clever", "coral", "dusty", "eager", "fuzzy",
  "gentle", "golden", "hasty", "ivory", "jolly", "keen", "lively", "lucky",
  "mellow", "misty", "noble", "olive", "perky", "quiet", "rosy", "salty",
  "shy", "sleek", "snug", "spry", "sturdy", "sunny", "tidy", "witty",
];
const ANIMAL = [
  "otter", "falcon", "badger", "cricket", "dolphin", "ferret", "gecko", "heron",
  "ibis", "jackal", "koala", "lemur", "marmot", "newt", "ocelot", "puffin",
  "quail", "raven", "seal", "tapir", "urchin", "vole", "walrus", "wren",
  "yak", "zebra", "bison", "crane", "dingo", "egret", "fox", "gull",
];

export function friendlyName(sessionId: string): string {
  // FNV-1a, split into two 5-bit picks — 1024 names, plenty for a demo's
  // handful of concurrent shells.
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  return `${ADJ[h & 31]}-${ANIMAL[(h >>> 5) & 31]}`;
}
