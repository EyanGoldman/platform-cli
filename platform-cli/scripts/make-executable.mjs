#!/usr/bin/env node
// Post-build: prepend a `#!/usr/bin/env node` shebang to dist/index.js and
// chmod +x so the `platform` bin works after `pnpm link`.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "dist", "index.js");

const SHEBANG = "#!/usr/bin/env node\n";

const original = readFileSync(entry, "utf8");
if (!original.startsWith("#!")) {
  writeFileSync(entry, SHEBANG + original);
}
chmodSync(entry, 0o755);
console.log(`[platform-cli] marked ${entry} executable`);
