// The shipped terminal-demo posture, for the labs that measure the real one.
//
// This used to be scraped out of `profile.ts` with a regex over the source
// text, in three copies. That worked while the profile was one template
// literal and stopped the moment it became a call into @fsio/confine — which
// is the better arrangement anyway: a lab that imports the built artifact
// measures exactly what ships and cannot drift from it by a character, which
// is the same reasoning that keeps `sandboxArgv` exported rather than
// inlined.
//
// The cost is that these labs now need a build. That is the right trade for
// an instrument: a measurement of a profile that is one edit stale is worse
// than a measurement that refused to run.

/** @returns {Promise<string>} the SBPL text a terminal-demo session gets. */
export async function shippedShellProfile() {
  try {
    const { SHELL_PROFILE } = await import("../packages/terminal-demo/dist/profile.js");
    return SHELL_PROFILE;
  } catch (e) {
    console.error("this lab measures the shipped profile, which is built code — run `npm run build` first.");
    console.error(`  (${e instanceof Error ? e.message : e})`);
    process.exit(1);
  }
}
