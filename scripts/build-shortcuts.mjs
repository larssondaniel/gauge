#!/usr/bin/env node
/**
 * Builds and signs the iOS Shortcuts this server needs (D-018), from the
 * secrets in .dev.vars and BASE_URL in wrangler.jsonc. Output goes to
 * shortcuts/build/ (git-ignored: the files embed the upload token).
 *
 *   node scripts/build-shortcuts.mjs
 *
 * Then AirDrop or open the .shortcut file on the iPhone.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const vars = Object.fromEntries(readFileSync(".dev.vars", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const baseUrl = /"BASE_URL":\s*"([^"]+)"/.exec(readFileSync("wrangler.jsonc", "utf8"))[1];
if (!vars.UPLOAD_TOKEN) throw new Error("UPLOAD_TOKEN missing from .dev.vars");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (s) => `<string>${esc(s)}</string>`;

/** A Shortcuts text value with optional attachments (variables) at U+FFFC positions. */
function tokenString(text, attachments = {}) {
  const ranges = Object.entries(attachments)
    .map(([range, a]) => `<key>${esc(range)}</key><dict><key>OutputName</key>${str(a.outputName)}<key>OutputUUID</key>${str(a.uuid)}<key>Type</key><string>ActionOutput</string></dict>`)
    .join("");
  return `<dict><key>Value</key><dict><key>attachmentsByRange</key><dict>${ranges}</dict><key>string</key>${str(text)}</dict><key>WFSerializationType</key><string>WFTextTokenString</string></dict>`;
}

function action(identifier, params) {
  return `<dict><key>WFWorkflowActionIdentifier</key>${str(identifier)}<key>WFWorkflowActionParameters</key><dict>${params}</dict></dict>`;
}

function workflow({ name, actions, inputClasses, types, glyph = 59511, color = -2873601 }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WFWorkflowActions</key><array>${actions.join("")}</array>
<key>WFWorkflowClientVersion</key><string>5037.111</string>
<key>WFWorkflowHasOutputFallback</key><false/>
<key>WFWorkflowHasShortcutInputVariables</key><true/>
<key>WFWorkflowIcon</key><dict><key>WFWorkflowIconGlyphNumber</key><integer>${glyph}</integer><key>WFWorkflowIconStartColor</key><integer>${color}</integer></dict>
<key>WFWorkflowImportQuestions</key><array/>
<key>WFWorkflowInputContentItemClasses</key><array>${inputClasses.map(str).join("")}</array>
<key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
<key>WFWorkflowMinimumClientVersionString</key><string>900</string>
<key>WFWorkflowName</key>${str(name)}
<key>WFWorkflowOutputContentItemClasses</key><array/>
<key>WFWorkflowTypes</key><array>${types.map(str).join("")}</array>
</dict></plist>`;
}

// ---- Upload to Gauge: share sheet -> POST /ingest/export -> notification with the server's one-line reply
const uploadUuid = randomUUID().toUpperCase();
const headers = `<dict><key>Value</key><dict><key>WFDictionaryFieldValueItems</key><array><dict><key>WFItemType</key><integer>0</integer><key>WFKey</key>${tokenString("Authorization")}<key>WFValue</key>${tokenString(`Bearer ${vars.UPLOAD_TOKEN}`)}</dict></array></dict><key>WFSerializationType</key><string>WFDictionaryFieldValue</string></dict>`;
const upload = workflow({
  name: "Upload to Gauge",
  inputClasses: ["WFGenericFileContentItem"],
  types: ["ActionExtension"],
  actions: [
    action(
      "is.workflow.actions.downloadurl",
      `<key>UUID</key>${str(uploadUuid)}<key>WFURL</key>${str(`${baseUrl}/ingest/export`)}<key>WFHTTPMethod</key><string>POST</string><key>WFHTTPBodyType</key><string>File</string><key>WFHTTPHeaders</key>${headers}<key>WFRequestVariable</key><dict><key>Value</key><dict><key>Type</key><string>ExtensionInput</string></dict><key>WFSerializationType</key><string>WFTextTokenAttachment</string></dict><key>ShowHeaders</key><true/>`,
    ),
    action(
      "is.workflow.actions.notification",
      `<key>WFNotificationActionBody</key>${tokenString("￼", { "{0, 1}": { outputName: "Contents of URL", uuid: uploadUuid } })}<key>WFNotificationActionTitle</key>${str("Gauge")}<key>WFNotificationActionSound</key><true/>`,
    ),
  ],
});

mkdirSync("shortcuts/build", { recursive: true });
const unsigned = "shortcuts/build/Upload to Gauge.unsigned.shortcut";
const signed = "shortcuts/build/Upload to Gauge.shortcut";
writeFileSync(unsigned, upload);
execFileSync("shortcuts", ["sign", "--mode", "anyone", "--input", unsigned, "--output", signed], { stdio: "inherit" });
console.log(`wrote ${signed}`);
