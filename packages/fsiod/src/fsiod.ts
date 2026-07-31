#!/usr/bin/env node
// The fsiod binary. Everything it does lives in daemon-cli.ts so that
// `fsio daemon` is the same code path, not a second implementation.
import { runDaemon } from "./daemon-cli.js";

process.exit(await runDaemon(process.argv.slice(2)));
