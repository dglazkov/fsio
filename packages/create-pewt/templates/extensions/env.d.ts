// Imported stylesheets are real to the build and unknown to the checker.
//
// The terminal extension writes `import "@xterm/xterm/css/xterm.css"`:
// esbuild collects the CSS and the host inlines it into the tab's one file,
// but tsc has no idea what importing a stylesheet means. This line tells
// `pewt check` and your editor what the build already knows, for every
// extension in this folder.
declare module "*.css";
