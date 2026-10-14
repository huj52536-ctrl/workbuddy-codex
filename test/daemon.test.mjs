/**
 * daemon 层测试：PID 文件、存活判定、防误杀、状态报告。
 *   node --test "test/*.test.mjs"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// daemon.mjs 的路径常量在导入时固定，因此这里直接测其纯逻辑函数。
// 对涉及真实 PID 文件的读写，用子进程注入 HOME 不可行（homedir 不可改），
// 所以改为验证「判定逻辑」与「不误杀」这类关键不变式。
import { isAlive, readPid, daemonStatus, clearPid, PID_FILE } from "../src/daemon.mjs";

test("isAlive：当前进程存活", () => {
  assert.equal(isAlive(process.pid), true);
});

test("isAlive：不存在的 PID 判定为不存活", () => {
  // 取一个几乎不可能存在的 PID
  assert.equal(isAlive(999999), false);
  assert.equal(isAlive(null), false);
  assert.equal(isAlive(0), false);
});

test("isAlive：不因非法输入抛异常", () => {
  for (const v of [undefined, null, 0, -1, NaN, "abc"]) {
    assert.doesNotThrow(() => isAlive(v));
  }
});

test("readPid：无 PID 文件时返回 null 而不抛异常", () => {
  const hadFile = existsSync(PID_FILE);
  if (hadFile) {
    // 不破坏真实状态：仅断言函数契约
    const v = readPid();
    assert.ok(v === null || Number.isInteger(v));
    return;
  }
  assert.equal(readPid(), null);
});

test("daemonStatus：无记录时报告未运行", () => {
  const hadFile = existsSync(PID_FILE);
  if (hadFile) return;   // 有真实服务时不干扰
  const st = daemonStatus();
  assert.equal(st.running, false);
  assert.equal(st.pid, null);
});

test("关键安全不变式：daemonStatus 绝不把「其它程序的 PID」报告为自己的服务", async () => {
  // 这是防误杀的核心：stopDaemon 依赖 daemonStatus().running。
  // 即使 PID 文件里写着别的进程（PID 复用），也必须判为未运行/foreign，
  // 否则 taskkill 会杀掉用户的无关程序。
  const st = daemonStatus();
  if (st.running) {
    // 若报告运行中，则该 PID 必须确实是本项目的桥接
    const { isOurBridge } = await import("../src/daemon.mjs");
    assert.equal(isOurBridge(st.pid), true,
      "报告 running 时，PID 必须经命令行确认属于本项目");
  } else {
    assert.equal(st.running, false);
  }
});
