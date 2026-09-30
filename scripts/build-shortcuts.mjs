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

// ---- Shared building blocks for the snapshot shortcuts (D-018)
const attach = (uuid, outputName) => ({ "{0, 1}": { outputName, uuid } });
const dateActions = () => {
  const dateUuid = randomUUID().toUpperCase();
  const isoUuid = randomUUID().toUpperCase();
  const tzUuid = randomUUID().toUpperCase();
  const dateToken = `<dict><key>Value</key><dict><key>OutputName</key>${str("Current Date")}<key>OutputUUID</key>${str(dateUuid)}<key>Type</key><string>ActionOutput</string></dict><key>WFSerializationType</key><string>WFTextTokenAttachment</string></dict>`;
  return {
    isoUuid,
    tzUuid,
    actions: [
      action("is.workflow.actions.date", `<key>UUID</key>${str(dateUuid)}<key>WFDateActionMode</key><string>Current Date</string>`),
      // ISO 8601 with time ("2026-09-30T23:55:00-04:00"): the server takes the date and the offset from it.
      // (A Custom style from a template rendered as an empty string on the phone, seen 2026-09-30.)
      action("is.workflow.actions.format.date", `<key>UUID</key>${str(isoUuid)}<key>WFInput</key>${dateToken}<key>WFDateFormatStyle</key><string>ISO 8601</string><key>WFISO8601IncludeTime</key><true/>`),
    ],
  };
};
const dictItem = (key, valueToken) => `<dict><key>WFItemType</key><integer>0</integer><key>WFKey</key>${tokenString(key)}<key>WFValue</key>${valueToken}</dict>`;
const dictionaryAction = (uuid, items) =>
  action("is.workflow.actions.dictionary", `<key>UUID</key>${str(uuid)}<key>WFItems</key><dict><key>Value</key><dict><key>WFDictionaryFieldValueItems</key><array>${items.join("")}</array></dict><key>WFSerializationType</key><string>WFDictionaryFieldValue</string></dict>`);
const postAction = (uuid, path, bodyUuid, bodyName) =>
  action(
    "is.workflow.actions.downloadurl",
    `<key>UUID</key>${str(uuid)}<key>WFURL</key>${str(`${baseUrl}${path}`)}<key>WFHTTPMethod</key><string>POST</string><key>WFHTTPBodyType</key><string>File</string><key>WFHTTPHeaders</key>${headers}<key>WFRequestVariable</key><dict><key>Value</key><dict><key>OutputName</key>${str(bodyName)}<key>OutputUUID</key>${str(bodyUuid)}<key>Type</key><string>ActionOutput</string></dict><key>WFSerializationType</key><string>WFTextTokenAttachment</string></dict><key>ShowHeaders</key><true/>`,
  );
const notifyAction = (postUuid) =>
  action("is.workflow.actions.notification", `<key>WFNotificationActionBody</key>${tokenString("\uFFFC", attach(postUuid, "Contents of URL"))}<key>WFNotificationActionTitle</key>${str("Gauge")}<key>WFNotificationActionSound</key><false/>`);

// MacroFactor's Get Nutrition State: nutrient by USDA nutrient number (Sodium = 307, seen in a real shortcut; the rest follow the same scheme).
const NUTRIENTS = { calories: ["208", "Calories"], protein: ["203", "Protein"], carbs: ["205", "Carbs"], fat: ["204", "Fat"], fiber: ["291", "Fiber"], alcohol: ["221", "Alcohol"], sodium: ["307", "Sodium"] };
const CALCS = { consumed: "consumed", remaining_goal: "remainingToTarget" };
const nutritionAction = (uuid, [id, title], calculation) =>
  action(
    "com.sbs.diet.GetNutritionStateAppIntent",
    `<key>AppIntentDescriptor</key><dict><key>AppIntentIdentifier</key><string>GetNutritionStateAppIntent</string><key>BundleIdentifier</key><string>com.sbs.diet</string><key>Name</key><string>MacroFactor</string><key>TeamIdentifier</key><string>QWPVJ94SN8</string></dict><key>UUID</key>${str(uuid)}<key>calculation</key>${str(calculation)}<key>target</key><dict><key>identifier</key>${str(id)}<key>title</key><dict><key>key</key>${str(title)}</dict><key>subtitle</key><dict><key>key</key>${str(title)}</dict><key>value</key>${str(id)}</dict>`,
  );

// ---- Gauge Nightly: 23:55 automation. 14 reads of Get Nutrition State -> dictionary -> POST /ingest/daily
{
  const d = dateActions();
  const reads = [];
  const items = [dictItem("date", tokenString("\uFFFC", attach(d.isoUuid, "Formatted Date")))];
  for (const [key, spec] of Object.entries(NUTRIENTS)) {
    for (const [calcKey, calcValue] of Object.entries(CALCS)) {
      const uuid = randomUUID().toUpperCase();
      reads.push(nutritionAction(uuid, spec, calcValue));
      items.push(dictItem(`${key}_${calcKey}`, tokenString("\uFFFC", attach(uuid, "Consumed or Remaining"))));
    }
  }
  const dictUuid = randomUUID().toUpperCase();
  const postUuid = randomUUID().toUpperCase();
  const nightly = workflow({
    name: "Gauge Nightly",
    inputClasses: [],
    types: [],
    glyph: 59446,
    color: 946986751,
    actions: [...d.actions, ...reads, dictionaryAction(dictUuid, items), postAction(postUuid, "/ingest/daily", dictUuid, "Dictionary"), notifyAction(postUuid)],
  });
  writeFileSync("shortcuts/build/Gauge Nightly.unsigned.shortcut", nightly);
}

// ---- Gauge Morning: "when MacroFactor is opened" automation. Daniel adds the two Health reads by hand and links them
//      into the empty weight_lb and steps_yesterday values (Find Health Samples cannot be authored reliably from a template).
{
  const d = dateActions();
  const dictUuid = randomUUID().toUpperCase();
  const postUuid = randomUUID().toUpperCase();
  const items = [dictItem("date", tokenString("\uFFFC", attach(d.isoUuid, "Formatted Date"))), dictItem("weight_lb", tokenString("")), dictItem("steps_yesterday", tokenString(""))];
  const morning = workflow({
    name: "Gauge Morning",
    inputClasses: [],
    types: [],
    glyph: 59446,
    color: 4282601983,
    actions: [...d.actions, dictionaryAction(dictUuid, items), postAction(postUuid, "/ingest/daily", dictUuid, "Dictionary"), notifyAction(postUuid)],
  });
  writeFileSync("shortcuts/build/Gauge Morning.unsigned.shortcut", morning);
}

mkdirSync("shortcuts/build", { recursive: true });
writeFileSync("shortcuts/build/Upload to Gauge.unsigned.shortcut", upload);
for (const name of ["Upload to Gauge", "Gauge Nightly", "Gauge Morning"]) {
  const unsigned = `shortcuts/build/${name}.unsigned.shortcut`;
  const signed = `shortcuts/build/${name}.shortcut`;
  execFileSync("shortcuts", ["sign", "--mode", "anyone", "--input", unsigned, "--output", signed], { stdio: "inherit" });
  console.log(`wrote ${signed}`);
}
