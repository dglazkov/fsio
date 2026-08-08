// Imported stylesheets are real to the build and unknown to the checker.
//
// The same line a scaffolded pewter writes as `extensions/env.d.ts`, and for
// the same reason: vite collects an imported stylesheet and tsc has no idea
// what importing one means. Here rather than in `src/`, because the kit
// itself imports no CSS — its elements carry their looks in `static styles`,
// and this page is the one thing in the package that behaves like a screen.
declare module "*.css";
