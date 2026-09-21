"use strict";

// 入口模块：表壳防水压检与交付准入相关接口处理器。
// 仅做取参、组织档案与响应；合格判定/准入重算全部调用 rules/pressure。
const store = require("../archive/store");
const pressure = require("../rules/pressure");
const {
  send,
  parseBody,
  httpError,
  required,
  numberField,
  stringField,
  parseTimestamp
} = require("./http");

const RECHECK_GAP_HOURS = 6;

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw httpError(404, "钟表不存在");
  return clock;
}

function findOrder(db, orderId) {
  const order = db.pressureOrders.find((item) => item.id === orderId);
  if (!order) throw httpError(404, "压检单不存在");
  return order;
}

function findTest(db, orderId, testId) {
  const test = db.pressureTests.find((item) => item.id === testId && item.orderId === orderId);
  if (!test) throw httpError(404, "压检记录不存在");
  return test;
}

function validAdmission(db, orderId) {
  return (
    (db.admissions || []).find((item) => item.orderId === orderId && item.status === "valid") || null
  );
}

// 写库后同步准入：旧准入依据不成立即作废（失效留痕），新依据成立即签发新准入
function syncAdmission(db, order, invalidReason) {
  const tests = pressure.orderTests(db, order.id);
  const pair = pressure.qualifyingPair(tests, order);
  const qualifies =
    pair &&
    !pair.insufficientGap &&
    pair.last.inspector !== pair.prev.inspector;
  const current = validAdmission(db, order.id);

  const basisMatches =
    current &&
    qualifies &&
    current.basis.firstTestId === pair.prev.id &&
    current.basis.secondTestId === pair.last.id;

  if (current && !basisMatches) {
    current.status = "invalid";
    current.invalidReason = invalidReason || "准入依据发生变化，按新数据重算";
    current.invalidatedAt = new Date().toISOString();
  }

  if (qualifies && (!current || current.status === "invalid")) {
    db.admissions.push({
      id: store.makeId("admission"),
      orderId: order.id,
      clockId: order.clockId,
      status: "valid",
      basis: {
        firstTestId: pair.prev.id,
        secondTestId: pair.last.id,
        firstTestedAt: pair.prev.testedAt,
        secondTestedAt: pair.last.testedAt,
        caseBatch: order.caseBatch,
        sealBatch: order.sealBatch
      },
      createdAt: new Date().toISOString(),
      invalidReason: null,
      invalidatedAt: null
    });
  }
}

function orderView(db, order) {
  const state = pressure.deliveryState(db, order);
  return {
    ...order,
    tests: state.tests,
    lastTest: state.lastTest,
    admission: state.admission || null,
    deliveryStatus: state.status,
    deliveryStatusLabel: state.statusLabel,
    admitted: state.admitted,
    deliveryBlockers: state.blockers
  };
}

// 每只表只能有一张未结束压检单；壳件/密封圈批次被未结束单占用 -> 409 且不落库
async function createOrder(params, body) {
  const db = await store.readDb();
  const clock = findClock(db, params.clockId);
  const caseBatch = stringField(body, "caseBatch");
  const sealBatch = stringField(body, "sealBatch");

  if (pressure.openOrder(db, clock.id)) {
    throw httpError(409, "该表已有未结束压检单，每只表只能开立一张", {
      conflict: "open_order",
      openOrderId: pressure.openOrder(db, clock.id).id
    });
  }
  for (const [kind, label] of [
    ["caseBatch", "壳件批次"],
    ["sealBatch", "密封圈批次"]
  ]) {
    const batch = kind === "caseBatch" ? caseBatch : sealBatch;
    const occupied = pressure.batchOccupation(db, kind, batch);
    if (occupied) {
      throw httpError(409, `${label} ${batch} 已被未结束压检单 ${occupied.id} 占用`, {
        conflict: kind,
        batch,
        occupiedBy: occupied.id,
        occupiedByClockId: occupied.clockId
      });
    }
  }

  const now = new Date().toISOString();
  const order = {
    id: store.makeId("ptorder"),
    clockId: clock.id,
    caseBatch,
    sealBatch,
    status: "open",
    note: body.note || "",
    changes: [],
    createdAt: now,
    closedAt: null
  };
  db.pressureOrders.push(order);
  await store.writeDb(db);
  return { status: 201, body: { data: orderView(db, order) } };
}

async function listOrders(query) {
  const db = await store.readDb();
  let orders = db.pressureOrders.slice();
  if (query.clockId) orders = orders.filter((item) => item.clockId === query.clockId);
  if (query.status) orders = orders.filter((item) => item.status === query.status);
  let data = orders
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((order) => orderView(db, order));
  if (query.admitted !== undefined) {
    data = data.filter((item) => item.admitted === (query.admitted === "true"));
  }
  return { status: 200, body: { data } };
}

async function listOrdersForClock(params) {
  const db = await store.readDb();
  findClock(db, params.clockId);
  const data = db.pressureOrders
    .filter((item) => item.clockId === params.clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((order) => orderView(db, order));
  return { status: 200, body: { data } };
}

async function getOrder(params) {
  const db = await store.readDb();
  const order = findOrder(db, params.orderId);
  return { status: 200, body: { data: orderView(db, order) } };
}

async function closeOrder(params, body) {
  const db = await store.readDb();
  const order = findOrder(db, params.orderId);
  if (order.status === "closed") {
    throw httpError(409, "压检单已结束，不能重复结束", { conflict: "already_closed" });
  }
  order.status = "closed";
  order.closedAt = parseTimestamp(body && body.closedAt, Date.now());
  if (body && body.note) order.note = body.note;
  await store.writeDb(db);
  return { status: 200, body: { data: orderView(db, order) } };
}

// 更换壳件/密封圈：批次冲突 409 不落库；实际换件让原准入失效并按新数据重算
async function patchOrder(params, body) {
  const db = await store.readDb();
  const order = findOrder(db, params.orderId);
  if (order.status === "closed") {
    throw httpError(409, "压检单已结束，不能更换批次", { conflict: "order_closed" });
  }

  const nextCase = body.caseBatch !== undefined ? String(body.caseBatch).trim() : order.caseBatch;
  const nextSeal = body.sealBatch !== undefined ? String(body.sealBatch).trim() : order.sealBatch;
  if (!nextCase || !nextSeal) throw httpError(400, "壳件批次和密封圈批次不能为空");

  for (const [kind, label, batch] of [
    ["caseBatch", "壳件批次", nextCase],
    ["sealBatch", "密封圈批次", nextSeal]
  ]) {
    const occupied = pressure.batchOccupation(db, kind, batch, order.id);
    if (occupied) {
      throw httpError(409, `${label} ${batch} 已被未结束压检单 ${occupied.id} 占用`, {
        conflict: kind,
        batch,
        occupiedBy: occupied.id,
        occupiedByClockId: occupied.clockId
      });
    }
  }

  const changes = [];
  if (nextCase !== order.caseBatch) {
    changes.push({ field: "caseBatch", from: order.caseBatch, to: nextCase });
    order.caseBatch = nextCase;
  }
  if (nextSeal !== order.sealBatch) {
    changes.push({ field: "sealBatch", from: order.sealBatch, to: nextSeal });
    order.sealBatch = nextSeal;
  }
  if (body.note !== undefined) order.note = String(body.note);

  if (changes.length) {
    const at = new Date().toISOString();
    order.changes = order.changes || [];
    order.changes.push({ at, changes, reason: body.changeReason || "更换壳件/密封圈" });
    await store.writeDb(db); // 先落换件事实，再按新数据重算准入
    syncAdmission(
      db,
      order,
      `更换${changes.map((c) => (c.field === "caseBatch" ? "壳件" : "密封圈")).join("/")}批次（${changes
        .map((c) => `${c.from} → ${c.to}`)
        .join("；")}），原准入失效`
    );
    await store.writeDb(db);
  } else {
    await store.writeDb(db);
  }
  return { status: 200, body: { data: orderView(db, order) } };
}

// 压检登记：目标深度、保压时长、初压、末压、泄漏量、检验人；不合格只转待复检
async function addTest(params, body) {
  const db = await store.readDb();
  const order = findOrder(db, params.orderId);
  if (order.status === "closed") {
    throw httpError(409, "压检单已结束，不能登记压检", { conflict: "order_closed" });
  }

  const targetDepthMeters = numberField(body, "targetDepthMeters");
  const holdMinutes = numberField(body, "holdMinutes");
  const startPressureBar = numberField(body, "startPressureBar", { allowNegative: true });
  const endPressureBar = numberField(body, "endPressureBar", { allowNegative: true });
  const leakRateBarPerMin = numberField(body, "leakRateBarPerMin");
  const inspector = stringField(body, "inspector");

  const tests = pressure.orderTests(db, order.id);

  // 复检须换人：首张之后的每次登记，检验人不得与上一张相同
  if (tests.length > 0) {
    const previous = tests[tests.length - 1];
    if (previous.inspector === inspector) {
      throw httpError(
        400,
        `复检须换人：上一检验人为 ${previous.inspector}，本次不得为同一人`,
        { conflict: "same_inspector", previousInspector: previous.inspector }
      );
    }
  }

  const testedAt = parseTimestamp(body.testedAt, Date.now());
  if (tests.length > 0 && new Date(testedAt) < new Date(tests[tests.length - 1].testedAt)) {
    throw httpError(400, "压检时间不能早于上一次压检");
  }

  const verdict = pressure.evaluateTest({
    targetDepthMeters,
    holdMinutes,
    startPressureBar,
    endPressureBar,
    leakRateBarPerMin
  });

  const test = {
    id: store.makeId("ptest"),
    orderId: order.id,
    clockId: order.clockId,
    sequence: tests.length + 1,
    targetDepthMeters,
    holdMinutes,
    startPressureBar,
    endPressureBar,
    pressureDropBar: verdict.pressureDropBar,
    leakRateBarPerMin,
    inspector,
    testedAt,
    result: verdict.result,
    qualified: verdict.qualified,
    failReasons: verdict.failReasons,
    // 登记时快照当前批次：换件前的旧记录不再计入新准入
    caseBatch: order.caseBatch,
    sealBatch: order.sealBatch,
    note: body.note || "",
    corrections: [],
    createdAt: new Date().toISOString(),
    correctedAt: null
  };
  db.pressureTests.push(test);

  syncAdmission(
    db,
    order,
    test.qualified
      ? "新增压检登记，准入按最近连续两次合格重新核算"
      : `新登记压检不合格（${test.failReasons.join("；")}），原准入失效`
  );
  await store.writeDb(db);

  return { status: 201, body: { data: test, order: orderView(db, order) } };
}

// 更正压检记录：留痕，原准入失效并按更正后的数据重算
async function patchTest(params, body) {
  const db = await store.readDb();
  const order = findOrder(db, params.orderId);
  if (order.status === "closed") {
    throw httpError(409, "压检单已结束，记录不可更正", { conflict: "order_closed" });
  }
  const test = findTest(db, order.id, params.testId);
  const reason = stringField(body, "reason");

  const before = {
    targetDepthMeters: test.targetDepthMeters,
    holdMinutes: test.holdMinutes,
    startPressureBar: test.startPressureBar,
    endPressureBar: test.endPressureBar,
    leakRateBarPerMin: test.leakRateBarPerMin,
    inspector: test.inspector,
    testedAt: test.testedAt,
    note: test.note
  };

  const next = {
    targetDepthMeters:
      body.targetDepthMeters !== undefined
        ? numberField(body, "targetDepthMeters")
        : test.targetDepthMeters,
    holdMinutes:
      body.holdMinutes !== undefined ? numberField(body, "holdMinutes") : test.holdMinutes,
    startPressureBar:
      body.startPressureBar !== undefined
        ? numberField(body, "startPressureBar", { allowNegative: true })
        : test.startPressureBar,
    endPressureBar:
      body.endPressureBar !== undefined
        ? numberField(body, "endPressureBar", { allowNegative: true })
        : test.endPressureBar,
    leakRateBarPerMin:
      body.leakRateBarPerMin !== undefined
        ? numberField(body, "leakRateBarPerMin")
        : test.leakRateBarPerMin,
    inspector:
      body.inspector !== undefined ? String(body.inspector).trim() : test.inspector,
    testedAt: body.testedAt !== undefined ? parseTimestamp(body.testedAt, test.testedAt) : test.testedAt,
    note: body.note !== undefined ? String(body.note) : test.note
  };

  if (!next.inspector) throw httpError(400, "检验人不能为空");

  // 更正不改变换人事实的判定口径：若更正后与相邻记录同人，按复检规则拒绝
  const tests = pressure.orderTests(db, order.id);
  const idx = tests.findIndex((item) => item.id === test.id);
  if (idx > 0 && tests[idx - 1].inspector === next.inspector) {
    throw httpError(
      400,
      `复检须换人：上一检验人为 ${tests[idx - 1].inspector}，更正后不得为同一人`,
      { conflict: "same_inspector" }
    );
  }
  if (idx >= 0 && idx < tests.length - 1 && tests[idx + 1].inspector === next.inspector) {
    throw httpError(
      400,
      `复检须换人：后一检验人为 ${tests[idx + 1].inspector}，更正后不得为同一人`,
      { conflict: "same_inspector" }
    );
  }

  Object.assign(test, next);
  const verdict = pressure.evaluateTest(test);
  test.qualified = verdict.qualified;
  test.result = verdict.result;
  test.failReasons = verdict.failReasons;
  test.pressureDropBar = verdict.pressureDropBar;
  test.correctedAt = new Date().toISOString();
  test.corrections.push({ at: test.correctedAt, reason, before, after: { ...next } });

  syncAdmission(db, order, `压检记录 ${test.id} 经更正（${reason}），原准入失效`);
  await store.writeDb(db);

  return { status: 200, body: { data: test, order: orderView(db, order) } };
}

async function listTests(query) {
  const db = await store.readDb();
  let data = db.pressureTests.slice();
  if (query.orderId) data = data.filter((item) => item.orderId === query.orderId);
  if (query.clockId) data = data.filter((item) => item.clockId === query.clockId);
  if (query.result) data = data.filter((item) => item.result === query.result);
  data.sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt));
  return { status: 200, body: { data } };
}

async function delivery(params) {
  const db = await store.readDb();
  findClock(db, params.clockId);
  const state = pressure.clockDeliveryState(db, params.clockId);
  return {
    status: 200,
    body: {
      data: {
        clockId: params.clockId,
        orderId: state.orderId,
        status: state.status,
        statusLabel: state.statusLabel,
        admitted: state.admitted,
        blockers: state.blockers,
        tests: state.tests || [],
        admission: state.admission || null,
        rule: {
          minDepthMeters: pressure.DEPTH_MIN_METERS,
          minHoldMinutes: pressure.HOLD_MIN_MINUTES,
          maxLeakBarPerMin: pressure.LEAK_MAX_BAR_PER_MIN,
          maxPressureDropBar: pressure.PRESSURE_DROP_MAX_BAR,
          recheckGapHours: RECHECK_GAP_HOURS,
          recheckMustSwitchInspector: true
        }
      }
    }
  };
}

module.exports = {
  createOrder,
  listOrders,
  listOrdersForClock,
  getOrder,
  closeOrder,
  patchOrder,
  addTest,
  patchTest,
  listTests,
  delivery,
  orderView
};
