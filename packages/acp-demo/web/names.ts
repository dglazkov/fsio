// A name for a conversation (#140 question 7). Chips used to be labelled
// with the agent's name, so three conversations with Claude were three
// identical chips distinguished only by position.
//
// The name is hashed from the fsio session id, which buys the two properties
// that matter here. Every page derives the SAME name for the same
// conversation with no coordination, so "amber-otter" in this window is
// "amber-otter" in the one that took it over and in the "+" list of a browser
// that has never seen it — which is what makes takeover (D18) legible. And it
// survives the session: a transcript is keyed by the same id, so a
// conversation keeps its name after it ends, which is what lets the running
// list and the ended list be one list.
//
// It deliberately claims nothing about what the conversation is *about*.
// Deriving that from the first prompt was the alternative, and it is a guess
// that is wrong whenever the opening prompt is not the subject.
//
// A second copy of `packages/terminal-demo/web/names.ts`, same algorithm, and
// it is a copy on purpose: two demos are the fast layer, free to be deleted
// independently (PROCESS.md), and the extraction signal is worth one more
// consumer before anybody acts on it.

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
  // handful of conversations in one folder.
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  return `${ADJ[h & 31]}-${ANIMAL[(h >>> 5) & 31]}`;
}
