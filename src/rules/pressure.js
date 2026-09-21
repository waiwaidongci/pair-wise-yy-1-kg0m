"use strict";

// 判定规则模块：压检合格判定、复检换人/间隔、交付准入重算。
// 全部为纯函数，入参为档案数据，不读盘不写盘。

const DEPTH_MIN_METERS = 100; // 目标深度最低 100 米
const HOLD_MIN_MINUTES = 30; // 保压时长最低 30 分钟
const LEAK_MAX_BAR_PER_MIN = 0.05; // 泄漏量上限 0.05 巴/分钟
const PRESSURE_DROP_MAX_BAR = 0.3; // 末压下降上限 0.3 巴
const RECHECK_GAP_MS = 6 * 60 * 60 * 1000; // 连续两次合格间隔至少 6 小时

const round4 = (value) => Math.round(value * 10000) / 10000;

// 单次压检是否合格；返回 { qualified, result, failReasons, pressureDropBar }
function evaluateTest(input) {
  const failReasons = [];
  if (input.targetDepthMeters < DEPTH_MIN_METERS) {
    failReasons.push(`目标深度 ${input.targetDepthMeters} 米，不足 ${DEPTH_MIN_METERS} 米`);
  }
  if (input.holdMinutes < HOLD_MIN_MINUTES) {
    failReasons.push(`保压时长 ${input.holdMinutes} 分钟，不足 ${HOLD_MIN_MINUTES} 分钟`);
  }
  if (input.leakRateBarPerMin > LEAK_MAX_BAR_PER_MIN) {
    failReasons.push(`泄漏量 ${input.leakRateBarPerMin} 巴/分钟，超过 ${LEAK_MAX_BAR_PER_MIN} 巴/分钟`);
  }
  const pressureDropBar = round4(input.startPressureBar - input.endPressureBar);
  if (pressureDropBar > PRESSURE_DROP_MAX_BAR) {
    failReasons.push(`末压下降 ${pressureDropBar.toFixed(2)} 巴，超过 ${PRESSURE_DROP_MAX_BAR.toFixed(2)} 巴`);
  }
  return {
    qualified: failReasons.length === 0,
    result: failReasons.length === 0 ? "pass" : "fail",
    failReasons,
    pressureDropBar
  };
}

function orderTests(db, orderId) {
  return db.pressureTests
    .filter((item) => item.orderId === orderId)
    .sort((a, b) => a.sequence - b.sequence || new Date(a.testedAt) - new Date(b.testedAt));
}

function openOrder(db, clockId) {
  return db.pressureOrders.find((item) => item.clockId === clockId && item.status === "open") || null;
}

function closedOrders(db, clockId) {
  return db.pressureTests && db.pressureOrders
    ? db.pressureOrders
        .filter((item) => item.clockId === clockId && item.status === "closed")
        .sort((a, b) => new Date(b.closedAt || b.createdAt) - new Date(a.closedAt || a.createdAt))
    : [];
}

// 批次是否被"未结束压检单"占用；excludeOrderId 用于 PATCH 时排除自身
function batchOccupation(db, kind, batch, excludeOrderId) {
  if (!batch) return null;
  return (
    db.pressureOrders.find(
      (item) =>
        item.status === "open" &&
        item.id !== excludeOrderId &&
        item[kind] === batch
    ) || null
  );
}

// 找到当前单上按当前批次数据、连续合格的最后两次压检
function qualifyingPair(tests, order) {
  const fromCurrentBatch = tests.filter(
    (item) => item.caseBatch === order.caseBatch && item.sealBatch === order.sealBatch
  );
  if (fromCurrentBatch.length < 2) return null;
  const prev = fromCurrentBatch[fromCurrentBatch.length - 2];
  const last = fromCurrentBatch[fromCurrentBatch.length - 1];
  if (!prev.qualified || !last.qualified) return null;
  const gapMs = new Date(last.testedAt) - new Date(prev.testedAt);
  if (gapMs < RECHECK_GAP_MS) return { prev, last, gapMs, insufficientGap: true };
  return { prev, last, gapMs, insufficientGap: false };
}

// 压检单交付准入状态（单一事实来源；列表/历史/交付状态共用）
function deliveryState(db, order) {
  if (!order) {
    return {
      order: null,
      status: "no_order",
      statusLabel: "无压检单",
      admitted: false,
      blockers: ["尚未开立压检单"]
    };
  }
  const tests = orderTests(db, order.id);
  const last = tests[tests.length - 1] || null;
  // 该单最近一张准入档案（含已作废的），用于识别"曾经准入后失效"
  const latestAdmission =
    (db.admissions || [])
      .filter((item) => item.orderId === order.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;

  const base = { orderId: order.id, orderStatus: order.status, tests, lastTest: last };

  if (order.status === "open" && tests.length === 0) {
    return { ...base, status: "awaiting_first", statusLabel: "待首检", admitted: false, blockers: ["尚无压检登记"] };
  }

  const pair = qualifyingPair(tests, order);
  const recomputed =
    pair &&
    !pair.insufficientGap &&
    pair.last.inspector !== pair.prev.inspector
      ? pair
      : null;

  // 1) 当前数据满足准入，且存在与之匹配的有效准入档案 -> 已准入
  const basisMatches =
    recomputed &&
    latestAdmission &&
    latestAdmission.status === "valid" &&
    latestAdmission.basis.firstTestId === recomputed.prev.id &&
    latestAdmission.basis.secondTestId === recomputed.last.id;
  if (basisMatches) {
    return {
      ...base,
      status: order.status === "open" ? "admitted" : "closed_admitted",
      statusLabel: "已准入",
      admitted: true,
      blockers: [],
      admission: latestAdmission
    };
  }

  // 2) 已结束且当前未准入（准入不可能在结束后再失效）
  if (order.status === "closed") {
    return {
      ...base,
      status: "closed",
      statusLabel: "已结束未准入",
      admitted: false,
      blockers: ["压检单已结束且未取得准入"],
      pair: pair || null
    };
  }

  // 3) 未结束单末次压检不合格：只转待复检（最高优先），提示下一次复检必须换人
  if (last && !last.qualified) {
    const blockers = ["末次压检不合格，转待复检"];
    blockers.push(`复检须换人：须由 ${last.inspector} 以外的检验人复检`);
    last.failReasons.forEach((reason) => blockers.push(reason));
    return {
      ...base,
      status: "awaiting_retest",
      statusLabel: "待复检",
      admitted: false,
      blockers,
      admission: latestAdmission
    };
  }

  // 4) 曾有准入但依据已不成立（换件/更正所致）-> 准入失效
  if (latestAdmission) {
    const blockers = ["原准入依据已因换件或记录更正失效，需按新数据重新取得连续两次合格"];
    if (pair && pair.insufficientGap) {
      const hours = Math.round((pair.gapMs / 3600000) * 10) / 10;
      blockers.push(`两次合格间隔仅 ${hours} 小时，须至少 6 小时`);
    }
    if (pair && pair.last.inspector === pair.prev.inspector) {
      blockers.push("第二次合格复检须由不同检验人完成");
    }
    if (!pair) blockers.push("需当前壳件/密封圈批次下连续两次合格");
    return {
      ...base,
      status: "admission_invalid",
      statusLabel: "准入失效",
      admitted: false,
      blockers,
      admission: latestAdmission,
      pair: pair || null
    };
  }

  // 5) 检验推进中：列出还差什么
  const blockers = [];
  if (!last || !last.qualified) blockers.push("末次压检须合格");
  if (!pair) {
    blockers.push("需当前壳件/密封圈批次下连续两次合格");
  } else if (pair.insufficientGap) {
    const hours = Math.round((pair.gapMs / 3600000) * 10) / 10;
    blockers.push(`两次合格间隔仅 ${hours} 小时，须至少 6 小时`);
  }
  if (pair && !pair.insufficientGap && pair.last.inspector === pair.prev.inspector) {
    blockers.push("第二次合格复检须由不同检验人完成");
  }
  if (blockers.length === 0) blockers.push("数据已满足准入，等待重新核算");
  return { ...base, status: "in_progress", statusLabel: "检验中", admitted: false, blockers, pair: pair || null };
}

// 表级交付状态：优先未结束单，否则取最近一张已结束单
function clockDeliveryState(db, clockId) {
  const open = openOrder(db, clockId);
  if (open) return deliveryState(db, open);
  const latestClosed = closedOrders(db, clockId)[0] || null;
  return deliveryState(db, latestClosed);
}

// 写库前复核：当前档案数据下，准入记录是否仍然有效
function reconcileAdmissions(db, orderId) {
  const order = db.pressureOrders.find((item) => item.id === orderId);
  if (!order) return;
  const state = deliveryState(db, order);
  const valid = (db.admissions || []).find(
    (item) => item.orderId === orderId && item.status === "valid"
  );
  if (valid && !state.admitted && valid.status === "valid") {
    valid.status = "invalid";
    valid.invalidReason = "准入依据不再满足（换件或记录更正后按新数据重算）";
    valid.invalidatedAt = new Date().toISOString();
  }
}

module.exports = {
  DEPTH_MIN_METERS,
  HOLD_MIN_MINUTES,
  LEAK_MAX_BAR_PER_MIN,
  PRESSURE_DROP_MAX_BAR,
  RECHECK_GAP_MS,
  evaluateTest,
  orderTests,
  openOrder,
  closedOrders,
  batchOccupation,
  qualifyingPair,
  deliveryState,
  clockDeliveryState,
  reconcileAdmissions
};
