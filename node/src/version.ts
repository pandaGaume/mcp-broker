import { createRequire } from "module";

// Resolves the package's own version from package.json without bundler help.
// Works both for the compiled dist/version.js (one level below package.json)
// and for tsc's source-level resolution from src/version.ts.
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string; name: string };

export const VERSION: string = pkg.version;
export const PACKAGE_NAME: string = pkg.name;
