#!/usr/bin/env node
/**
 * Command Code 额度 / 用量查询。
 *
 * 数据源是 Command Code 未公开但接受「provider API key」的 /alpha/* 路由
 * （dashboard 用的 /internal/* 只认浏览器 session cookie，API key 会 401）：
 *   GET /alpha/billing/credits        月度剩余额度 + 5h/周窗口
 *   GET /alpha/billing/subscriptions  套餐 id 与账单周期
 *   GET /alpha/usage/summary          本周期花费 / 调用数 / token
 * 鉴权头是 x-api-key（不是 Bearer）。
 *
 * 用法：node quota.mjs [--json]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://api.commandcode.ai";
const CREDITS_PATH = "/alpha/billing/credits";
const SUBS_PATH = "/alpha/billing/subscriptions";
const SUMMARY_PATH = "/alpha/usage/summary";

/** 各套餐每月包含额度（USD），取自 Command Code /docs/resources/usage-limits。有序：先匹配到的赢。 */
const PLAN_CREDITS = [
  ["max-20", 300],
  ["max-10", 150],
  ["max", 300],
  ["goat", 70],
  ["team", 40],
  ["pro", 80],
  ["go", 10],
];
const PLAN_NAMES = { go: "Go", goat: "GOAT", pro: "Pro", max: "Max" };

// ---------------------------------------------------------------- 取密钥

function envFromFile(path, name) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

/** provider_config.json 里 commandcode 路由的 apiKey（ZCode 用户可直接复用已配置的 key）。 */
function keyFromProviderConfig() {
  const path = join(homedir(), ".zcode", "v2", "provider_config.json");
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    const rules = cfg?.config?.providerConfigRules?.providerRules ?? [];
    const hit = rules.find((r) => r?.providerId === "commandcode");
    const key = hit?.config?.access?.apiKey;
    return typeof key === "string" && key.trim() !== "" ? key.trim() : null;
  } catch {
    return null;
  }
}

function resolveKey() {
  const sources = [
    ["$CMD_API_KEY", () => process.env.CMD_API_KEY?.trim() || null],
    ["~/.zcode/v2/provider_config.json", keyFromProviderConfig],
  ];
  for (const [label, read] of sources) {
    let value = null;
    try {
      value = read();
    } catch {
      value = null;
    }
    if (value) return { key: value, source: label };
  }
  return { key: null, source: null };
}

// ---------------------------------------------------------------- 取数

async function get(path, key) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-api-key": key, accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round2 = (v) => Math.round(v * 100) / 100;

function planKeyOf(planId) {
  return String(planId ?? "").trim().replace(/^individual[-_]/, "").toLowerCase();
}

/** API 报的是「还剩多少」，月度上限来自套餐表；套餐未知时退回 剩余+已花。 */
function monthlyGrant(planKey, credits, spent) {
  for (const [needle, grant] of PLAN_CREDITS) if (planKey.includes(needle)) return grant;
  if (!credits || spent === null) return null;
  return credits.remaining + spent + credits.purchased + credits.free;
}

function planNameOf(planKey) {
  if (planKey === "") return null;
  return PLAN_NAMES[planKey] ?? planKey.charAt(0).toUpperCase() + planKey.slice(1);
}

async function collect(key) {
  const [creditsBody, subsBody, summaryBody] = await Promise.all([
    get(CREDITS_PATH, key),
    get(SUBS_PATH, key).catch(() => null),
    get(SUMMARY_PATH, key).catch(() => null),
  ]);

  const creditsRaw = creditsBody?.credits;
  const credits =
    creditsRaw && num(creditsRaw.monthlyCredits) !== null
      ? {
          remaining: num(creditsRaw.monthlyCredits),
          purchased: num(creditsRaw.purchasedCredits) ?? 0,
          free: num(creditsRaw.freeCredits) ?? 0,
        }
      : null;

  const data = subsBody?.data ?? subsBody ?? {};
  const planKey = planKeyOf(data?.planId);
  const spent = num(summaryBody?.totalCost);

  const out = {
    plan: planNameOf(planKey),
    planId: planKey || null,
    periodStart: data?.currentPeriodStart ?? null,
    periodEnd: data?.currentPeriodEnd ?? null,
    monthly: null,
    windows: [],
    usage: null,
  };

  const grant = monthlyGrant(planKey, credits, spent);
  if (credits && grant && grant > 0) {
    const used = Math.max(0, grant - credits.remaining);
    out.monthly = {
      grant: round2(grant),
      used: round2(used),
      remaining: round2(credits.remaining),
      usedPercent: round1((used / grant) * 100),
    };
  } else if (credits) {
    out.monthly = { grant: null, used: null, remaining: round2(credits.remaining), usedPercent: null };
  }

  const limits = creditsBody?.windowLimits;
  for (const [kind, label] of [
    ["fiveHour", "5 小时"],
    ["weekly", "本周"],
  ]) {
    const entry = limits?.[kind];
    const used = num(entry?.used);
    const cap = num(entry?.cap);
    if (used === null || cap === null || cap <= 0) continue;
    out.windows.push({
      kind: label,
      used: round2(used),
      cap: round2(cap),
      usedPercent: round1((used / cap) * 100),
      resetAt: num(entry?.resetAt) === null ? null : new Date(entry.resetAt).toISOString(),
    });
  }

  if (summaryBody) {
    out.usage = {
      spent: spent === null ? null : round2(spent),
      calls: num(summaryBody.totalCount),
      completed: num(summaryBody.completedCount),
      failed: num(summaryBody.failedCount),
      successRate: num(summaryBody.successRate),
      tokens: num(summaryBody.totalTokens),
      tokensIn: num(summaryBody.totalTokensIn),
      tokensOut: num(summaryBody.totalTokensOut),
      basis: summaryBody.periodBasis ?? null,
    };
  }
  return out;
}

// ---------------------------------------------------------------- 渲染

function round1(v) {
  return Math.round(v * 10) / 10;
}

function bar(percent, width = 16) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtReset(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = Date.now();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.getTime() - now < 24 * 3600 * 1000) return `${hm} 重置`;
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${md} ${hm} 重置`;
}

function fmtDay(iso) {
  if (!iso) return "?";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtTokens(n) {
  if (n === null) return "?";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function render(d, source) {
  const L = [];
  const planLabel = d.plan ?? "Command Code";
  const left = d.monthly?.remaining;
  L.push(`Command Code — ${planLabel}${left === null || left === undefined ? "" : ` · $${left.toFixed(2)} left`}`);
  if (d.periodStart || d.periodEnd) {
    L.push(`账单周期  ${fmtDay(d.periodStart)} → ${fmtDay(d.periodEnd)}`);
  }
  if (d.monthly) {
    const m = d.monthly;
    if (m.grant === null) {
      L.push(`月度额度  ${bar(0)}   剩余 $${m.remaining.toFixed(2)}（上限未知）`);
    } else {
      L.push(
        `月度额度  ${bar(m.usedPercent)} ${m.usedPercent.toFixed(1).padStart(5)}%  用掉 $${m.used.toFixed(2)} / $${m.grant.toFixed(2)}（剩 $${m.remaining.toFixed(2)}）`
      );
    }
  }
  for (const w of d.windows) {
    const reset = fmtReset(w.resetAt);
    L.push(
      `${w.kind.padEnd(8)}  ${bar(w.usedPercent)} ${w.usedPercent.toFixed(1).padStart(5)}%  ${w.used.toFixed(2)} / ${w.cap.toFixed(2)}${reset ? ` · ${reset}` : ""}`
    );
  }
  if (d.usage) {
    const u = d.usage;
    const bits = [];
    if (u.spent !== null) bits.push(`$${u.spent.toFixed(2)}`);
    if (u.calls !== null) bits.push(`${u.calls.toLocaleString("en-US")} 次调用`);
    if (u.tokens !== null) bits.push(`${fmtTokens(u.tokens)} tok（入 ${fmtTokens(u.tokensIn)} / 出 ${fmtTokens(u.tokensOut)}）`);
    if (bits.length) L.push(`本周期累计 ${bits.join(" · ")}`);
    if (u.successRate !== null) L.push(`成功率    ${u.successRate}%${u.failed ? `（失败 ${u.failed}）` : ""}`);
  }
  L.push(`密钥来源  ${source}`);
  return L.join("\n");
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("用法: node quota.mjs [--json]\n\n查询 Command Code 账户的额度余量、限流窗口与本期用量。");
  process.exit(0);
}

const { key, source } = resolveKey();
if (!key) {
  console.error("找不到 Command Code API key。");
  console.error("请设置环境变量 CMD_API_KEY（export CMD_API_KEY=...），或确保 ~/.zcode/v2/provider_config.json 里配了 commandcode 路由。");
  process.exit(1);
}

try {
  const data = await collect(key);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...data, credentialSource: source }, null, 2));
  } else {
    console.log(render(data, source));
  }
} catch (error) {
  console.error(`查询失败: ${error.message}`);
  process.exit(1);
}
