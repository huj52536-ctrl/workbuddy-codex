/**
 * daemon.mjs —— 把桥接服务作为**分离进程**启动/停止/查看
 *
 * 目标：让 `install` 不再霸占终端。启动后父进程立即返回，
 * 服务在后台独立存活，用户关掉终端（甚至关掉 DSH）也继续运行。
 *
 * 跨平台策略：
 *   - Windows：用 `wscript` 执行一个临时 VBS 启动 node（真正无窗口、无控制台）。
 *     仅用 `detached: true` 仍可能闪出控制台窗口，VBS 更干净。
 *   - macOS / Linux：`spawn(..., { detached: true })` + `unref()`，
 *     子进程进入独立会话（setsid 语义），父进程退出不受影响。
 *
 * 另外写一个 PID 文件，用于 stop / status，避免误杀其它 node 进程。
 */

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const HOME_DIR = join(homedir(), ".workbuddy-codex");
export const PID_FILE = join(HOME_DIR, "bridge.pid");
export const LOG_FILE = join(HOME_DIR, "bridge.log");

/** 读取记录的 PID（不存在或损坏返回 null）。 */
export function readPid() {
  try {
    if (!existsSync(PID_FILE)) return null;
    const n = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** 进程是否存活。 */
export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === "EPERM"; }   // 存在但无权限 → 视为存活
}

/**
 * 确认某 PID 确实是**本项目的桥接服务**，而不是 PID 被复用的其它程序。
 * 通过命令行内容判断，避免 stop 时误杀。
 */
export function isOurBridge(pid) {
  if (!isAlive(pid)) return false;
  try {
    const cmd = process.platform === "win32"
      ? execFileSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
      : execFileSync("ps", ["-p", String(pid), "-o", "args="], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
    return /workbuddy-codex/i.test(cmd ?? "");
  } catch { return false; }
}

/** 当前记录的守护进程状态。 */
export function daemonStatus() {
  const pid = readPid();
  if (!pid) return { running: false, pid: null };
  if (!isAlive(pid)) return { running: false, pid, stale: true };
  if (!isOurBridge(pid)) return { running: false, pid, foreign: true };
  return { running: true, pid };
}

/**
 * 以分离进程方式启动桥接服务。
 *
 * 注意 PID 的获取方式：Windows 下经 wscript/VBS 启动时，父进程**拿不到**
 * 子进程 PID（VBS 是中间人）。因此约定：**由子进程自己**在端口就绪后调用
 * writeOwnPid() 落盘，父进程随后用 waitForPid() 读取确认。
 *
 * @param {{root:string, nodePath:string, args:string[], port:number}} opts
 */
export function startDetached({ root, nodePath, args, port }) {
  mkdirSync(HOME_DIR, { recursive: true });
  // 清掉上一次的 PID，避免误读陈旧值
  clearPid();

  const entry = "bin/workbuddy-codex.mjs";

  if (process.platform === "win32") {
    // 用 VBS 启动：wscript 本身不创建控制台，node 也随之无窗口。
    const vbsPath = join(HOME_DIR, "bridge-launch.vbs");
    const vbs = [
      `' 由 workbuddy-codex 生成：无窗口启动桥接服务`,
      `Set s = CreateObject("WScript.Shell")`,
      `s.CurrentDirectory = "${root}"`,
      `s.Run """${nodePath}"" ${entry} ${args.join(" ")}", 0, False`,
      ``,
    ].join("\r\n");
    writeFileSync(vbsPath, vbs, "utf8");
    execFileSync("wscript.exe", [vbsPath], { windowsHide: true });
  } else {
    const child = spawn(nodePath, [entry, ...args], {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (child.pid) writeFileSync(PID_FILE, String(child.pid), "utf8");
  }
}

/** 轮询等待子进程把自己 PID 写进 PID 文件。 */
export async function waitForPid(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPid();
    if (pid && isAlive(pid)) return pid;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * 停止守护进程。
 * @returns {{stopped:boolean, pid:number|null, reason?:string}}
 */
export function stopDaemon() {
  const st = daemonStatus();
  if (!st.running) {
    if (st.pid) clearPid();
    return { stopped: false, pid: st.pid, reason: st.foreign ? "PID 被其它程序占用" : "未运行" };
  }
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(st.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(st.pid, "SIGTERM");
    }
    clearPid();
    return { stopped: true, pid: st.pid };
  } catch (e) {
    return { stopped: false, pid: st.pid, reason: e.message };
  }
}

/** 由服务自身写入 PID（启动成功后调用）。 */
export function writeOwnPid() {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid), "utf8");
  } catch { /* ignore */ }
}

export function clearPid() {
  try { if (existsSync(PID_FILE)) rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
}

/**
 * 等待端口可用（用于启动后确认服务真的起来了）。
 * @param {number} port
 * @param {number} timeoutMs
 */
export async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}
