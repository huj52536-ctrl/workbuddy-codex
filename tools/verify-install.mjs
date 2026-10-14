#!/usr/bin/env node
/**
 * verify-install.mjs —— 完整安装验证
 *
 * 在**完全隔离**的环境里跑一遍真实用户旅程，绝不动真实 HOME：
 *   USERPROFILE / LOCALAPPDATA / APPDATA / CODEX_HOME 全部指向临时目录。
 *
 * 覆盖：
 *   1. 全新机器 install（区域自动推断）
 *   2. 生成的 config.toml 与模型目录合法性
 *   3. 真实 Codex CLI 经桥接端到端调用
 *   4. 后台服务生命周期（status / restart）
 *   5. 重复 install 幂等
 *   6. uninstall 精确还原
 *   7. --region intl 在无国际版凭据时**拒绝写配置**（不能把 Codex 弄坏）
 *   8. 真实 HOME 自始至终未被改动
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCodexBin } from "../src/codex-config.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const CODEX = process.env.CODEX_BIN || findCodexBin();
const PORT = 8844;
const MARKER = "INSTALL_FULL_VERIFY_OK";

const results = [];
function check(ok, label, detail) {
  results.push({ ok, label });
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
  if (!ok && detail) console.log(`      ${String(detail).slice(0, 400)}`);
}
function section(t) { console.log(`\n${"─".repeat(64)}\n${t}\n`); }

// ---- 隔离环境 ----
const WORK = mkdtempSync(join(tmpdir(), "wbcx-verify-"));
const FAKE_HOME = join(WORK, "home");
const CODEX_HOME = join(FAKE_HOME, ".codex");
mkdirSync(CODEX_HOME, { recursive: true });
mkdirSync(join(FAKE_HOME, ".workbuddy-codex"), { recursive: true });
mkdirSync(join(FAKE_HOME, "AppData", "Local"), { recursive: true });
mkdirSync(join(FAKE_HOME, "AppData", "Roaming"), { recursive: true });

const REAL_CONFIG = join(homedir(), ".codex", "config.toml");
const realConfigBefore = existsSync(REAL_CONFIG) ? readFileSync(REAL_CONFIG, "utf8") : null;

// 造一份可用凭据（模拟"用户已在 DSH 或桌面端登录过"）
const realSession = join(homedir(), ".workbuddy-codex", "session.json");
if (!existsSync(realSession)) {
  console.error(`缺少真实会话文件，无法验证：${realSession}`);
  process.exit(2);
}
copyFileSync(realSession, join(FAKE_HOME, ".workbuddy-codex", "session.json"));

const env = {
  ...process.env,
  USERPROFILE: FAKE_HOME,
  LOCALAPPDATA: join(FAKE_HOME, "AppData", "Local"),
  APPDATA: join(FAKE_HOME, "AppData", "Roaming"),
  CODEX_HOME,
};
for (const k of ["WORKBUDDY_API_KEY", "WORKBUDDY_SESSION_FILE", "WORKBUDDY_CODEX_REGION", "WORKBUDDY_BRIDGE_KEY"]) {
  delete env[k];
}

function cli(args, { timeout = 180000 } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "bin", "workbuddy-codex.mjs"), ...args], {
      cwd: ROOT, env, encoding: "utf8", timeout, input: "", windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function codexExec(prompt) {
  if (!CODEX) return { code: -1, out: "找不到 codex 可执行文件" };
  try {
    const out = execFileSync(CODEX, ["exec", "--skip-git-repo-check", prompt], {
      cwd: ROOT, env, encoding: "utf8", timeout: 240000, input: "", windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const CFG = join(CODEX_HOME, "config.toml");
const CATALOG = join(CODEX_HOME, "workbuddy-models.json");
const readCfg = () => (existsSync(CFG) ? readFileSync(CFG, "utf8") : "");

console.log(`隔离 HOME : ${FAKE_HOME}`);
console.log(`Codex     : ${CODEX ?? "(未找到)"}`);

let failure = null;
try {
  // ---------------------------------------------------------------- 1
  section("1) 全新机器 install（区域自动推断）");
  const inst = cli(["install", "--port", String(PORT)]);
  check(inst.code === 0, "install 退出码为 0", inst.out);
  check(/已在后台运行/.test(inst.out), "桥接服务已在后台运行", inst.out);
  check(/自检通过/.test(inst.out), "真实自检通过", inst.out);
  check(/中国区/.test(inst.out), "自动推断出中国区", inst.out);
  check(existsSync(CFG), "已写入 config.toml");

  // ---------------------------------------------------------------- 2
  section("2) 生成物合法性");
  const cfg = readCfg();
  check(cfg.includes("[model_providers.workbuddy]"), "config 含 workbuddy provider");
  check(/wire_api\s*=\s*"responses"/.test(cfg), "wire_api = responses");
  check(!/wire_api\s*=\s*"chat"/.test(cfg), "没有 wire_api=\"chat\"（会让 Codex 拒绝启动）");
  check(cfg.includes(`127.0.0.1:${PORT}`), `base_url 指向 127.0.0.1:${PORT}`);
  check(/^model_provider\s*=\s*"workbuddy"$/m.test(cfg), "model_provider 指向 workbuddy");
  const our = cfg.split("# >>> workbuddy-codex >>>")[1]?.split("# <<< workbuddy-codex <<<")[0] ?? "";
  check(!/env_key/.test(our), "托管段内没有 env_key（桌面版读不到终端环境变量）");
  check(!/WORKBUDDY_BRIDGE_KEY/.test(our), "没有残留的占位密钥名");

  check(existsSync(CATALOG), "已生成模型目录");
  const cat = JSON.parse(readFileSync(CATALOG, "utf8"));
  const e0 = cat.models?.[0] ?? {};
  check(Object.values(e0).every((v) => v !== null), "模型目录无 null 值字段（null 会让 Codex 拒绝加载）");
  check(Boolean(e0.base_instructions) || Boolean(e0.model_messages), "含 base_instructions / model_messages");
  check("support_verbosity" in e0, "含 support_verbosity");
  check((cat.models?.length ?? 0) > 0, `模型数量 ${cat.models?.length ?? 0}`);

  // ---------------------------------------------------------------- 3
  section("3) 真实 Codex CLI 端到端");
  const e2e = codexExec(`Reply with exactly: ${MARKER}`);
  check(e2e.code === 0, "codex exec 退出码为 0", e2e.out);
  check(e2e.out.includes(MARKER), `模型返回了 ${MARKER}`, e2e.out);
  check(!/Missing environment variable/.test(e2e.out), "没有 env_key 报错", e2e.out);
  check(!/failed to parse model_catalog_json/.test(e2e.out), "模型目录被 Codex 正常加载", e2e.out);

  // ---------------------------------------------------------------- 4
  section("4) 后台服务生命周期");
  const st1 = cli(["service", "status"]);
  check(/运行中/.test(st1.out), "service status 报告运行中", st1.out);
  const pid1 = Number((st1.out.match(/pid\s+(\d+)/) ?? [])[1] ?? 0);
  const rs = cli(["service", "restart"]);
  check(rs.code === 0 && /已启动/.test(rs.out), "service restart 成功", rs.out);
  const st2 = cli(["service", "status"]);
  const pid2 = Number((st2.out.match(/pid\s+(\d+)/) ?? [])[1] ?? 0);
  check(pid1 > 0 && pid2 > 0 && pid1 !== pid2, `restart 换新进程（${pid1} → ${pid2}）`);

  // ---------------------------------------------------------------- 5
  section("5) 重复 install 幂等");
  const again = cli(["install", "--port", String(PORT)]);
  check(again.code === 0, "再次 install 成功", again.out);
  const blocks = (readCfg().match(/\[model_providers\.workbuddy\]/g) ?? []).length;
  check(blocks === 1, `provider 段只有 1 个（实际 ${blocks}）`);

  // ---------------------------------------------------------------- 6
  section("6) uninstall 精确还原");
  const un = cli(["uninstall"]);
  check(un.code === 0, "uninstall 成功", un.out);
  const after = readCfg();
  check(!after.includes("model_providers.workbuddy"), "workbuddy provider 已移除");
  check(!/^model_provider\s*=\s*"workbuddy"$/m.test(after), "model_provider 已还原/移除");
  check(!after.includes("workbuddy-codex-state"), "还原用的状态注释已清理");

  // ---------------------------------------------------------------- 7
  section("7) --region intl 无凭据时拒绝写配置");
  const intl = cli(["install", "--region", "intl", "--port", String(PORT + 1)]);
  check(intl.code !== 0, "install --region intl 未成功（凭据不属于国际版）", intl.out);
  check(!readCfg().includes("model_providers.workbuddy"), "失败时未把 workbuddy 写进配置", readCfg());
  check(/intl|国际版/.test(intl.out), "给出了区域相关的说明", intl.out);
} catch (e) {
  failure = e;
  console.log(`\n异常中断：${e.message}`);
} finally {
  try { cli(["service", "stop"], { timeout: 30000 }); } catch { /* ignore */ }
  // 守护进程刚被终止时文件句柄可能尚未释放，稍等再删（删不掉也不影响结论）
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 5; i++) {
    try { rmSync(WORK, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 800)); }
  }
  if (existsSync(WORK)) console.log(`（临时目录未能删除，可手动清理：${WORK}）`);
}

// ---------------------------------------------------------------- 8
section("8) 真实环境未被改动");
const realConfigAfter = existsSync(REAL_CONFIG) ? readFileSync(REAL_CONFIG, "utf8") : null;
check(realConfigBefore === realConfigAfter, "真实 ~/.codex/config.toml 与验证前完全一致");

// ---- 汇总 ----
const failed = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(64)}`);
console.log(`共 ${results.length} 项检查，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log("\n失败项：");
  for (const f of failed) console.log(`  ✗ ${f.label}`);
}
console.log("═".repeat(64));
if (failure) process.exit(3);
process.exit(failed.length ? 1 : 0);
