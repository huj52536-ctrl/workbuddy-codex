// Inspect the desktop credential files: determine whether tokens are plaintext
// or encrypted envelopes, without printing any secret material.
import { readFileSync, existsSync } from "node:fs";

const dir = `${process.env.LOCALAPPDATA}\\CodeBuddyExtension\\Data\\Public\\auth`;
const files = [
  `${dir}\\workbuddy-desktop.info`,
  `${dir}\\workbuddy-desktop.2026-07-02T05-04-14-391Z.info`,
];

const describe = (v) => {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return `string(len=${v.length})${v.length > 30 ? " <- PLAINTEXT?" : ""}`;
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if ("$wbEncrypted" in v) {
      return `ENCRYPTED envelope(len=${String(v.envelope ?? "").length}) keys=${keys.join(",")}`;
    }
    return `object keys=${keys.join(",")}`;
  }
  return `${typeof v} = ${JSON.stringify(v)}`;
};

for (const f of files) {
  console.log("=".repeat(74));
  console.log(f);
  if (!existsSync(f)) { console.log("  (missing)"); continue; }
  let j;
  try { j = JSON.parse(readFileSync(f, "utf8")); }
  catch (e) { console.log("  parse error:", e.message); continue; }

  console.log("  top-level keys:", Object.keys(j).join(", "));
  console.log("  --- auth ---");
  for (const [k, v] of Object.entries(j.auth ?? {})) {
    console.log(`    ${k}: ${describe(v)}`);
  }
  console.log("  --- account ---");
  for (const [k, v] of Object.entries(j.account ?? {})) {
    if (["uid", "uin", "type", "accountType", "mpOpenId"].includes(k)) {
      console.log(`    ${k}: ${describe(v)}`);
    } else if (v && typeof v === "object") {
      console.log(`    ${k}: ${describe(v)}`);
    }
  }
  const exp = j.auth?.expiresAt;
  if (exp) {
    console.log(`  expiresAt: ${new Date(Number(exp)).toISOString()} | expired=${Number(exp) < Date.now()}`);
  }
}
