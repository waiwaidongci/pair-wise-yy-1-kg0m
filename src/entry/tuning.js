"use strict";

// 入口模块：原钟表建档、走时调校与复测接口处理器。
const store = require("../archive/store");
const tuning = require("../rules/tuning");
const pressureRules = require("../rules/pressure");
const { send, parseBody, httpError, required } = require("./http");

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw httpError(404, "钟表不存在");
  return clock;
}

async function listClocks(query) {
  const db = await store.readDb();
  let data = db.clocks.map((clock) => tuning.clockSummary(db, clock, pressureRules));
  if (query.qualified !== undefined) {
    data = data.filter((clock) => clock.qualified === (query.qualified === "true"));
  }
  if (query.admitted !== undefined) {
    data = data.filter((clock) => clock.admitted === (query.admitted === "true"));
  }
  if (query.deliveryStatus) {
    data = data.filter((clock) => clock.deliveryStatus === query.deliveryStatus);
  }
  return { status: 200, body: { data } };
}

async function notQualifiedClocks() {
  const db = await store.readDb();
  const data = db.clocks
    .map((clock) => tuning.clockSummary(db, clock, pressureRules))
    .filter((clock) => !clock.qualified);
  return { status: 200, body: { data } };
}

async function createClock(body) {
  required(body, ["code", "escapementType", "balanceFrequency"]);
  const db = await store.readDb();
  const clock = {
    id: store.makeId("clock"),
    code: body.code,
    escapementType: body.escapementType,
    balanceFrequency: body.balanceFrequency,
    targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
    note: body.note || "",
    createdAt: new Date().toISOString()
  };
  db.clocks.push(clock);
  await store.writeDb(db);
  return { status: 201, body: { data: tuning.clockSummary(db, clock, pressureRules) } };
}

async function clockHistory(params) {
  const db = await store.readDb();
  const clock = findClock(db, params.clockId);
  const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
  const retests = db.retests.filter((item) => item.clockId === clock.id);
  const pressureOrders = db.pressureOrders
    .filter((item) => item.clockId === clock.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((order) => {
      const tests = pressureRules.orderTests(db, order.id);
      const state = pressureRules.deliveryState(db, order);
      return {
        ...order,
        tests,
        deliveryStatus: state.status,
        deliveryStatusLabel: state.statusLabel,
        admitted: state.admitted,
        deliveryBlockers: state.blockers,
        admission: state.admission || null
      };
    });
  const pressureTests = db.pressureTests.filter((item) => item.clockId === clock.id);
  const admissions = (db.admissions || []).filter((item) => item.clockId === clock.id);
  return {
    status: 200,
    body: {
      data: {
        clock,
        adjustments,
        retests,
        latestRetest: tuning.latestRetest(db, clock.id),
        pressureOrders,
        pressureTests,
        admissions,
        delivery: pressureRules.clockDeliveryState(db, clock.id)
      }
    }
  };
}

async function addAdjustment(params, body) {
  required(body, ["currentDailyRateSeconds", "direction", "amount"]);
  const db = await store.readDb();
  const clock = findClock(db, params.clockId);
  const adjustment = {
    id: store.makeId("adjustment"),
    clockId: clock.id,
    currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
    direction: body.direction,
    amount: body.amount,
    note: body.note || "",
    createdAt: new Date().toISOString()
  };
  db.adjustments.push(adjustment);
  await store.writeDb(db);
  return { status: 201, body: { data: adjustment } };
}

async function addRetest(params, body) {
  required(body, ["dailyRateSeconds", "amplitude"]);
  const db = await store.readDb();
  const clock = findClock(db, params.clockId);
  const adjustmentId = body.adjustmentId || tuning.latestAdjustment(db, clock.id)?.id || null;
  const qualified =
    body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
  const retest = {
    id: store.makeId("retest"),
    clockId: clock.id,
    adjustmentId,
    testedAt: body.testedAt || new Date().toISOString(),
    dailyRateSeconds: Number(body.dailyRateSeconds),
    amplitude: Number(body.amplitude),
    qualified,
    note: body.note || ""
  };
  db.retests.push(retest);
  await store.writeDb(db);
  return { status: 201, body: { data: retest, clock: tuning.clockSummary(db, clock, pressureRules) } };
}

async function latestRetest(params) {
  const db = await store.readDb();
  findClock(db, params.clockId);
  return { status: 200, body: { data: tuning.latestRetest(db, params.clockId) } };
}

async function listAdjustments(query) {
  const db = await store.readDb();
  return {
    status: 200,
    body: { data: db.adjustments.filter((item) => !query.clockId || item.clockId === query.clockId) }
  };
}

async function listRetests(query) {
  const data0 = await store.readDb();
  const data = data0.retests.filter((item) => {
    const matchClock = !query.clockId || item.clockId === query.clockId;
    const matchQualified = query.qualified === undefined || item.qualified === (query.qualified === "true");
    return matchClock && matchQualified;
  });
  return { status: 200, body: { data } };
}

module.exports = {
  listClocks,
  notQualifiedClocks,
  createClock,
  clockHistory,
  addAdjustment,
  addRetest,
  latestRetest,
  listAdjustments,
  listRetests
};
