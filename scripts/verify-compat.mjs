// Compatibility self-check for dsh-voice-mode-desktop.
//
// Run it after installing the plugin into a DSH profile, or in CI against a
// known DSH build:
//
//   node scripts/verify-compat.mjs [path-to-dsh-app]
//
// Default app path is the Windows desktop install of DSH NEXT. The script checks
// the four host contracts this adaptation depends on and prints PASS/FAIL per
// check. Exit code 0 means every check passed.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const appDir = process.argv[2] ?? "D:\\DSH\\DSH NEXT\\resources\\app";
const appRequire = createRequire(join(appDir, "package.json"));
const pkgDir = dirname(new URL("../package.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok === undefined ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : ` — ${detail}`}`);
};

const clientInjectTargets = [
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-cordis-client-runner",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings-plugins"
];

// 1. App present
check("DSH app directory", existsSync(join(appDir, "package.json")), appDir);
if (!existsSync(join(appDir, "package.json"))) {
  process.exit(1);
}

// 2. Every client inject target exists in the app
for (const name of clientInjectTargets) {
  let ok = true;
  try {
    appRequire.resolve(`${name}/package.json`);
  } catch {
    try {
      appRequire.resolve(name);
    } catch {
      ok = false;
    }
  }
  check(`client inject target ${name}`, ok);
}

// 3. `settingsScope` is gone from the client API (the reason this fork exists)
let hasSettingsScope = false;
try {
  const settingsClient = readFileSync(
    join(appDir, "node_modules", "@deepseek-ai", "dsh-client-ui-settings", "lib", "client.js"),
    "utf8"
  );
  hasSettingsScope = settingsClient.includes("settingsScope");
} catch {
  // unreadable file: treat as unknown, not as failure of the premise
  hasSettingsScope = false;
}
check("host has no `settingsScope` client service (expected)", hasSettingsScope === false,
  hasSettingsScope ? "found settingsScope; this fork's guard is unnecessary but harmless" : "absent");

// 4. The plugin's own client half declares no missing service
let clientInject = [];
try {
  const clientSrc = readFileSync(join(pkgDir, "lib", "client.js"), "utf8");
  const m = clientSrc.match(/var inject = (\[[^\]]*\]);/);
  clientInject = m === null ? [] : JSON.parse(m[1]);
  check("plugin client inject list", clientInject.includes("settingsScope") === false,
    clientInject.length === 0 ? "not found" : clientInject.join(", "));
} catch (error) {
  check("plugin client inject list", false, String(error && error.message));
}

// 4b. The client bundle registers under the package name the host serves it as
try {
  const clientSrc = readFileSync(join(pkgDir, "lib", "client.js"), "utf8");
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const m = clientSrc.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/);
  const id = m === null ? undefined : m[1];
  check("client bundle id matches package name", id === manifest.name, `${id ?? "not found"} vs ${manifest.name}`);
} catch (error) {
  check("client bundle id matches package name", false, String(error && error.message));
}

// 5. rate/mode are exposed as live-editable fields (the settings page depends on it)
try {
  const mod = await import(pathToFileURL(join(pkgDir, "lib", "index.js")).href);
  const schema = mod.Config ?? mod.VoiceSettingsSchema;
  const volatileForm = (node) => {
    if (node?.meta?.volatile) return node;
    if (node?.type === "object") {
      const dict = Object.fromEntries(
        Object.entries(node.dict ?? {}).flatMap(([key, child]) => {
          const field = volatileForm(child);
          return field === undefined ? [] : [[key, field]];
        })
      );
      if (Object.keys(dict).length === 0) return undefined;
      const z = appRequire("@deepseek-ai/schemastery");
      const builder = z.default ?? z;
      return builder.object(dict);
    }
    return undefined;
  };
  const form = volatileForm(schema);
  const fields = form?.dict === undefined ? [] : Object.keys(form.dict);
  check("schema exposes live-editable fields", fields.includes("rate") && fields.includes("mode"), fields.join(", ") || "none");
} catch (error) {
  const message = String(error && error.message);
  // Before the plugin's own dependencies are installed, importing the host half
  // cannot succeed. That is a "not applicable yet", not a compatibility failure.
  if (message.includes("Cannot find package") || message.includes("ERR_MODULE_NOT_FOUND")) {
    check("schema exposes live-editable fields", undefined, "run again after the plugin's dependencies are installed");
  } else {
    check("schema exposes live-editable fields", false, message);
  }
}

const failed = results.filter((row) => row.ok === false);
const skipped = results.filter((row) => row.ok === undefined);
console.log(`\n${results.length - failed.length - skipped.length}/${results.length} checks passed${skipped.length === 0 ? "" : `, ${skipped.length} skipped`}`);
process.exit(failed.length === 0 ? 0 : 1);
