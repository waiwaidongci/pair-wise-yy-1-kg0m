"use strict";

// 表壳防水压检与交付准入 —— 判定规则模块（纯函数，无副作用）

const MIN_DEPTH_METERS = 100;
const MIN_HOLD_MINUTES = 30;
const MAX_LEAK_BAR_PER_MIN = 0.05;
const MAX_PRESSURE_DROP_BAR = 0.3;
const ADMISSION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const FAILURE_LABELS = {
  depth: "目标深度不足100米",
  hold: "保压时长不足30分钟",
  leak: "泄漏量超过0.05巴/分钟",
  drop: "末压下降超过0.3巴"
};

// 单张压检记录的不合格项；全部满足才合格
function inspectionFailures(inspection) {
  const failures = [];
  if (Number(inspection.targetDepthM) < MIN_DEPTH_METERS) failures.push("depth");
  if (Number(inspection.holdMinutes) < MIN_HOLD_MINUTES) failures.push("hold");
  if (Number(inspection.leakBarPerMin) > MAX_LEAK_BAR_PER_MIN) failures.push("leak");
  if (Number(inspection.initialBar) - Number(inspection.finalBar) > MAX_PRESSURE_DROP_BAR) failures.push("drop");
  return failures;
}

// 为登记/更正后的记录补上派生字段（压降、不合格项、合格标记）
function decorateInspection(inspection) {
  const pressureDropBar = Number(inspection.initialBar) - Number(inspection.finalBar);
  const failures = inspectionFailures(inspection);
  return {
    ...inspection,
    pressureDropBar: Number(pressureDropBar.toFixed(4)),
    failureReasons: failures.map((key) => FAILURE_LABELS[key]),
    failureCodes: failures,
    qualified: failures.length === 0
  };
}

// 复检换人：检验人与上一张压检记录不同
function retestViolations(orderedInspections) {
  const violations = [];
  for (let index = 1; index < orderedInspections.length; index += 1) {
    if (orderedInspections[index].inspector === orderedInspections[index - 1].inspector) {
      violations.push({
        seq: orderedInspections[index].seq,
        inspector: orderedInspections[index].inspector,
        reason: "复检须换人，检验人与上一张压检记录相同"
      });
    }
  }
  return violations;
}

// 按登记顺序排列压检记录
function orderedInspections(inspections) {
  return [...inspections].sort((a, b) =>
    a.seq === b.seq
      ? new Date(a.registeredAt) - new Date(b.registeredAt)
      : a.seq - b.seq
  );
}

// 评估一张压检单的当前状态。准入结论全部由原始记录实时推导：
// 任何更正都会在读取时被重算，不存在“旧准入”残留。
function evaluateOrder(order, inspectionsForOrder) {
  if (order.supersededAt) {
    return {
      phase: "superseded",
      qualified: false,
      admitted: false,
      active: false,
      blockers: [order.supersededReason || "压检单已被替换"],
      admission: null
    };
  }

  const inspections = orderedInspections(inspectionsForOrder).map(decorateInspection);
  const inspectorViolations = retestViolations(inspections);
  const last = inspections[inspections.length - 1] || null;

  if (!last) {
    return {
      phase: "testing",
      qualified: false,
      admitted: false,
      active: true,
      blockers: ["尚未登记压检记录"],
      admission: null
    };
  }

  if (!last.qualified) {
    return {
      phase: "pending_retest",
      qualified: false,
      admitted: false,
      active: true,
      blockers: last.failureReasons,
      lastInspectionId: last.id,
      admission: null
    };
  }

  // 最后一张合格：需要“连续两次合格 + 间隔≥6小时 + 换人”才能准入
  const previous = inspections[inspections.length - 2] || null;
  const admission = {
    qualifiedStreak: 2,
    intervalMs: null,
    inspectorsDifferent: false,
    pair: null
  };

  if (previous && previous.qualified) {
    const intervalMs = new Date(last.testedAt) - new Date(previous.testedAt);
    const inspectorsDifferent = last.inspector !== previous.inspector;
    admission.intervalMs = intervalMs;
    admission.inspectorsDifferent = inspectorsDifferent;
    admission.pair = [previous.id, last.id];
    if (intervalMs >= ADMISSION_INTERVAL_MS && inspectorsDifferent) {
      return {
        phase: "admitted",
        qualified: true,
        admitted: true,
        active: false,
        blockers: [],
        lastInspectionId: last.id,
        admittedAt: last.registeredAt,
        admission
      };
    }
  }

  const blockers = [];
  if (!previous || !previous.qualified) blockers.push("需连续两次合格压检");
  const intervalMs =
    previous && previous.qualified
      ? new Date(last.testedAt) - new Date(previous.testedAt)
      : null;
  if (intervalMs !== null && intervalMs < ADMISSION_INTERVAL_MS) {
    blockers.push("两次合格压检间隔须至少6小时");
  }
  if (previous && previous.qualified && last.inspector === previous.inspector) {
    blockers.push("两次合格压检须由不同检验人完成");
  }

  return {
    phase: "awaiting_second",
    qualified: true,
    admitted: false,
    active: true,
    blockers,
    lastInspectionId: last.id,
    admission,
    retestViolations: inspectorViolations
  };
}

// 非终态、占用壳件/密封圈批次的压检单
function isActiveOrder(order, evaluation) {
  return !order.supersededAt && evaluation.active !== false && !evaluation.admitted;
}

// 某只表的全部压检单（按开张时间升序）
function ordersOf(db, clockId) {
  return db.pressureOrders
    .filter((order) => order.clockId === clockId)
    .sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
}

function evaluationsForClock(db, clockId) {
  return ordersOf(db, clockId).map((order) => ({
    order,
    evaluation: evaluateOrder(
      order,
      db.pressureInspections.filter((inspection) => inspection.orderId === order.id)
    )
  }));
}

// 当前生效（最新且未作废）压检单的评估；更早的单子只用于历史追溯
function currentEvaluation(db, clockId) {
  const list = evaluationsForClock(db, clockId);
  return list.length ? list[list.length - 1] : null;
}

// 交付准入状态：列表、单表历史、交付台共用同一推导入口，保证一致
function deliveryForClock(db, clock) {
  const current = currentEvaluation(db, clock.id);
  if (!current) {
    return {
      status: "not_started",
      label: "未开始压检",
      admitted: false,
      active: false,
      orderId: null,
      blockers: ["尚未开压检单"],
      lastInspection: null
    };
  }

  const { order, evaluation } = current;
  const labels = {
    pending_retest: "待复检",
    awaiting_second: "待第二次合格确认",
    testing: "压检中",
    admitted: "准许交付",
    superseded: "压检单已作废"
  };

  return {
    status: evaluation.phase,
    label: labels[evaluation.phase],
    admitted: Boolean(evaluation.admitted),
    active: evaluation.active,
    orderId: order.id,
    blockers: evaluation.blockers,
    admission: evaluation.admission || null,
    lastInspectionId: evaluation.lastInspectionId || null,
    lastInspection: evaluation.lastInspectionId
      ? db.pressureInspections.find((item) => item.id === evaluation.lastInspectionId) || null
      : null
  };
}

// 全部占用批次的在途压检单（排除其他表 + 可选的自身压检单）
function activeOrderIndex(db, options = {}) {
  const entries = [];
  for (const order of db.pressureOrders) {
    if (order.supersededAt) continue;
    const evaluation = evaluateOrder(
      order,
      db.pressureInspections.filter((inspection) => inspection.orderId === order.id)
    );
    if (isActiveOrder(order, evaluation) && order.id !== options.excludeOrderId) {
      entries.push({ order, evaluation });
    }
  }
  return entries;
}

// 占用冲突预检。任何 409 都必须在写库前调用，命中即不落库。
// reopenFromOrderId：更正压检记录可能让“已准入”单重新占用批次
function occupationConflicts(db, payload, options = {}) {
  const conflicts = [];
  for (const { order } of activeOrderIndex(db, { excludeOrderId: options.reopenFromOrderId })) {
    if (order.clockId === payload.clockId) {
      conflicts.push({
        code: "ORDER_OPEN_EXISTS",
        message: "该表已有未结束压检单，每只表只能有一张未结束压检单",
        orderId: order.id
      });
    }
    if (payload.caseBatchNo && order.caseBatchNo === payload.caseBatchNo && order.clockId !== payload.clockId) {
      conflicts.push({
        code: "CASE_BATCH_OCCUPIED",
        message: `壳件批次 ${payload.caseBatchNo} 已被压检单 ${order.id} 占用`,
        orderId: order.id,
        batchField: "caseBatchNo",
        batchNo: payload.caseBatchNo
      });
    }
    if (payload.sealBatchNo && order.sealBatchNo === payload.sealBatchNo && order.clockId !== payload.clockId) {
      conflicts.push({
        code: "SEAL_BATCH_OCCUPIED",
        message: `密封圈批次 ${payload.sealBatchNo} 已被压检单 ${order.id} 占用`,
        orderId: order.id,
        batchField: "sealBatchNo",
        batchNo: payload.sealBatchNo
      });
    }
  }
  return conflicts;
}

function conflictError(conflicts) {
  const error = new Error(conflicts[0].message);
  error.status = 409;
  error.code = conflicts[0].code;
  error.conflicts = conflicts;
  return error;
}

module.exports = {
  MIN_DEPTH_METERS,
  MIN_HOLD_MINUTES,
  MAX_LEAK_BAR_PER_MIN,
  MAX_PRESSURE_DROP_BAR,
  ADMISSION_INTERVAL_MS,
  FAILURE_LABELS,
  inspectionFailures,
  decorateInspection,
  orderedInspections,
  retestViolations,
  evaluateOrder,
  isActiveOrder,
  ordersOf,
  evaluationsForClock,
  currentEvaluation,
  deliveryForClock,
  activeOrderIndex,
  occupationConflicts,
  conflictError
};
