"use strict";

// 档案存储模块：负责所有业务档案的落盘与读取，不承载任何判定逻辑。
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "..", "data", "db.json");

const COLLECTIONS = [
  "clocks",
  "adjustments",
  "retests",
  "pressureOrders",
  "pressureTests",
  "admissions"
];

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: "2026-06-16T00:00:00.000Z",
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  // 压检单（示例：一张未结束、末次压检不合格、处于待复检的单子）
  pressureOrders: [
    {
      id: "ptorder_demo",
      clockId: "clock_demo",
      caseBatch: "CASE-316L-042",
      sealBatch: "SEAL-FKM-088",
      status: "open",
      note: "表示例压检单，末压下降超标，等待换人复检",
      createdAt: "2026-09-18T02:00:00.000Z",
      closedAt: null
    }
  ],
  pressureTests: [
    {
      id: "ptest_demo",
      orderId: "ptorder_demo",
      clockId: "clock_demo",
      sequence: 1,
      targetDepthMeters: 120,
      holdMinutes: 30,
      startPressureBar: 5,
      endPressureBar: 4.6,
      pressureDropBar: 0.4,
      leakRateBarPerMin: 0.02,
      inspector: "王师傅",
      testedAt: "2026-09-18T02:30:00.000Z",
      result: "fail",
      qualified: false,
      failReasons: ["末压下降 0.40 巴，超过 0.30 巴"],
      caseBatch: "CASE-316L-042",
      sealBatch: "SEAL-FKM-088",
      note: "首次压检",
      corrections: [],
      createdAt: "2026-09-18T02:30:00.000Z",
      correctedAt: null
    }
  ],
  admissions: []
};

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let data = null;
  try {
    data = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return;
  }
  // 旧档案迁移：补齐新增集合，保证老库可直接升级
  let migrated = false;
  for (const name of COLLECTIONS) {
    if (!Array.isArray(data[name])) {
      data[name] = initialData[name] || [];
      migrated = true;
    }
  }
  if (migrated) await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { DB_FILE, COLLECTIONS, initialData, readDb, writeDb, makeId };
