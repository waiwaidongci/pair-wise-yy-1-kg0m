"use strict";

// 表壳防水压检与交付准入 —— 档案存储模块
// 负责 data/db.json 的读写：集合补齐、初始化种子数据、写操作串行化。
// 业务判定不在此处，统一交由 lib/rules.js。

const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.PRESSURE_DB_FILE || path.join(__dirname, "..", "data", "db.json");

const COLLECTIONS = [
  "clocks",
  "adjustments",
  "retests",
  "pressureOrders",
  "pressureInspections",
  "componentChanges",
  "pressureCorrections"
];

function makeSeedData() {
  const now = new Date();
  const iso = (offsetHours) => new Date(now.getTime() + offsetHours * 3600 * 1000).toISOString();
  return {
    pressureOrders: [
      {
        id: "pressure_order_demo",
        clockId: "clock_demo",
        caseBatchNo: "CASE-A01",
        sealBatchNo: "SEAL-B07",
        openedAt: iso(-30),
        supersededAt: null,
        supersededReason: null
      }
    ],
    pressureInspections: [
      {
        id: "pressure_insp_demo_1",
        orderId: "pressure_order_demo",
        clockId: "clock_demo",
        seq: 1,
        targetDepthM: 120,
        holdMinutes: 35,
        initialBar: 5.2,
        finalBar: 5.05,
        leakBarPerMin: 0.02,
        pressureDropBar: 0.15,
        inspector: "张师傅",
        testedAt: iso(-24),
        registeredAt: iso(-24),
        note: "首检合格",
        failureCodes: [],
        failureReasons: [],
        qualified: true,
        correctedAt: null
      },
      {
        id: "pressure_insp_demo_2",
        orderId: "pressure_order_demo",
        clockId: "clock_demo",
        seq: 2,
        targetDepthM: 120,
        holdMinutes: 40,
        initialBar: 5.2,
        finalBar: 5.02,
        leakBarPerMin: 0.03,
        pressureDropBar: 0.18,
        inspector: "李师傅",
        testedAt: iso(-8),
        registeredAt: iso(-8),
        note: "复检合格，间隔满6小时，换人",
        failureCodes: [],
        failureReasons: [],
        qualified: true,
        correctedAt: null
      }
    ],
    componentChanges: [],
    pressureCorrections: []
  };
}

// 老档案库向前兼容：缺什么集合补什么，不覆盖既有数据
function normalize(db) {
  for (const name of COLLECTIONS) {
    if (!Array.isArray(db[name])) db[name] = [];
  }
  // 全新空库时补充一张交付准入示例，便于直接体验交付台
  if (db.clocks.some((clock) => clock.id === "clock_demo") && db.pressureOrders.length === 0) {
    Object.assign(db, makeSeedData());
  }
  return db;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let db;
  try {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    db = {};
  }
  const before = JSON.stringify(db);
  normalize(db);
  if (JSON.stringify(db) !== before) {
    await writeFile(DB_FILE, JSON.stringify(db, null, 2));
  }
  return db;
}

async function readDb() {
  return ensureDb();
}

async function writeDb(db) {
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

// 写操作排队：读改写整库期间不允许交叉，保证“冲突不落库”与档案一致性
let writeChain = Promise.resolve();
function mutate(worker) {
  const run = writeChain.then(async () => {
    const db = await readDb();
    const result = await worker(db);
    await writeDb(db);
    return result;
  });
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { DB_FILE, readDb, writeDb, mutate, makeId };
