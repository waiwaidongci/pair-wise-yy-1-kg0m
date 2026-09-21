"use strict";

// 表壳防水压检与交付准入 —— 入口模块（HTTP 路由、参数校验、请求编排）
// 判定规则见 lib/rules.js，档案读写见 lib/archive.js

const http = require("http");
const { readDb, mutate, makeId } = require("./archive");
const rules = require("./rules");

const {
  decorateInspection,
  orderedInspections,
  evaluateOrder,
  ordersOf,
  deliveryForClock,
  occupationConflicts,
  conflictError,
  MIN_DEPTH_METERS,
  MIN_HOLD_MINUTES,
  MAX_LEAK_BAR_PER_MIN,
  MAX_PRESSURE_DROP_BAR,
  ADMISSION_INTERVAL_MS
} = rules;

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /delivery-board",
  "GET /clocks/:id/history",
  "GET /clocks/:id/delivery",
  "POST /clocks/:id/component-change",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /clocks/:id/pressure-orders",
  "POST /clocks/:id/pressure-orders",
  "GET /adjustments",
  "GET /retests",
  "GET /pressure-orders",
  "GET /pressure-orders/:orderId",
  "POST /pressure-orders/:orderId/inspections",
  "GET /pressure-inspections",
  "PATCH /pressure-inspections/:inspectionId",
  "GET /component-changes",
  "GET /pressure-corrections"
];

const INSPECTION_NUMERIC_FIELDS = [
  { key: "targetDepthM", positive: true },
  { key: "holdMinutes", positive: true },
  { key: "initialBar", positive: true },
  { key: "finalBar", positive: true },
  { key: "leakBarPerMin", nonnegative: true }
];
const PATCHABLE_FIELDS = [
  ...INSPECTION_NUMERIC_FIELDS.map((field) => field.key),
  "inspector",
  "testedAt",
  "note"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function httpError(status, message, code, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code || null;
  Object.assign(error, extra);
  return error;
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "请求体必须是合法JSON", "INVALID_JSON");
  }
}

function requireStrings(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || String(body[field]).trim() === "") {
      throw httpError(400, `缺少字段：${field}`, "MISSING_FIELD");
    }
  }
}

function numericValue(raw, field, options) {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    throw httpError(400, `缺少字段：${field}`, "MISSING_FIELD");
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw httpError(400, `字段 ${field} 必须是数字`, "INVALID_NUMBER");
  }
  if (options.positive && value <= 0) throw httpError(400, `字段 ${field} 必须大于0`, "INVALID_NUMBER");
  if (options.nonnegative && value < 0) throw httpError(400, `字段 ${field} 不能为负数`, "INVALID_NUMBER");
  return value;
}

function requireInspectionMetrics(body) {
  const metrics = {};
  for (const field of INSPECTION_NUMERIC_FIELDS) {
    metrics[field.key] = numericValue(body[field.key], field.key, field);
  }
  return metrics;
}

function parseTestedAt(body) {
  if (body.testedAt === undefined || body.testedAt === null || body.testedAt === "") {
    return new Date().toISOString();
  }
  const date = new Date(body.testedAt);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, "字段 testedAt 必须是合法时间", "INVALID_DATE");
  }
  return date.toISOString();
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw httpError(404, "钟表不存在", "CLOCK_NOT_FOUND");
  return clock;
}

function findOrder(db, orderId) {
  const order = db.pressureOrders.find((item) => item.id === orderId);
  if (!order) throw httpError(404, "压检单不存在", "PRESSURE_ORDER_NOT_FOUND");
  return order;
}

function findInspection(db, inspectionId) {
  const inspection = db.pressureInspections.find((item) => item.id === inspectionId);
  if (!inspection) throw httpError(404, "压检记录不存在", "PRESSURE_INSPECTION_NOT_FOUND");
  return inspection;
}

// 压检单视图：状态与合格结论全部由规则模块实时推导
function orderView(db, order) {
  const inspections = orderedInspections(
    db.pressureInspections.filter((item) => item.orderId === order.id)
  ).map(decorateInspection);
  const state = evaluateOrder(order, inspections);
  return { order, inspections, state };
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    caseBatchNo: clock.caseBatchNo ?? null,
    sealBatchNo: clock.sealBatchNo ?? null,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false,
    delivery: deliveryForClock(db, clock)
  };
}

// ---------- 写操作处理器 ----------

// 开张压检单：每只表唯一未结束单 + 壳件/密封圈批次占用，冲突一律 409 且不写库
async function openPressureOrder(clockId, body) {
  requireStrings(body, ["caseBatchNo", "sealBatchNo"]);
  const caseBatchNo = String(body.caseBatchNo).trim();
  const sealBatchNo = String(body.sealBatchNo).trim();

  return mutate((db) => {
    const clock = findClock(db, clockId);

    // 批次是壳件/密封圈实体属性：开单批次与档案当前批次不符时，必须先走换件登记
    if (clock.caseBatchNo && clock.caseBatchNo !== caseBatchNo) {
      throw httpError(422, `壳件批次与档案当前批次 ${clock.caseBatchNo} 不符，更换壳件须先登记换件`, "CASE_BATCH_MISMATCH");
    }
    if (clock.sealBatchNo && clock.sealBatchNo !== sealBatchNo) {
      throw httpError(422, `密封圈批次与档案当前批次 ${clock.sealBatchNo} 不符，更换密封圈须先登记换件`, "SEAL_BATCH_MISMATCH");
    }

    const conflicts = occupationConflicts(db, { clockId: clock.id, caseBatchNo, sealBatchNo });
    if (conflicts.length) throw conflictError(conflicts);

    const now = new Date().toISOString();
    const order = {
      id: makeId("pressure_order"),
      clockId: clock.id,
      caseBatchNo,
      sealBatchNo,
      note: body.note ? String(body.note) : "",
      openedAt: now,
      supersededAt: null,
      supersededReason: null,
      supersededByChangeId: null
    };
    db.pressureOrders.push(order);
    if (!clock.caseBatchNo) clock.caseBatchNo = caseBatchNo;
    if (!clock.sealBatchNo) clock.sealBatchNo = sealBatchNo;

    return { clock, order, view: orderView(db, order) };
  });
}

// 更换壳件/密封圈：当前压检单立即作废、占用释放，原准入失效，按新批次重新压检
async function registerComponentChange(clockId, body) {
  const hasCase = body.caseBatchNo !== undefined && String(body.caseBatchNo).trim() !== "";
  const hasSeal = body.sealBatchNo !== undefined && String(body.sealBatchNo).trim() !== "";
  if (!hasCase && !hasSeal) {
    throw httpError(400, "至少提供 caseBatchNo 或 sealBatchNo", "MISSING_FIELD");
  }
  const toCaseBatchNo = hasCase ? String(body.caseBatchNo).trim() : null;
  const toSealBatchNo = hasSeal ? String(body.sealBatchNo).trim() : null;

  return mutate((db) => {
    const clock = findClock(db, clockId);
    const fromCaseBatchNo = clock.caseBatchNo ?? null;
    const fromSealBatchNo = clock.sealBatchNo ?? null;
    const nextCase = toCaseBatchNo ?? fromCaseBatchNo;
    const nextSeal = toSealBatchNo ?? fromSealBatchNo;

    if (nextCase === fromCaseBatchNo && nextSeal === fromSealBatchNo) {
      throw httpError(400, "新批次与档案当前批次完全相同，无需换件登记", "BATCH_UNCHANGED");
    }

    const change = {
      id: makeId("component_change"),
      clockId: clock.id,
      changedCase: hasCase,
      changedSeal: hasSeal,
      fromCaseBatchNo,
      toCaseBatchNo: toCaseBatchNo ?? fromCaseBatchNo,
      fromSealBatchNo,
      toSealBatchNo: toSealBatchNo ?? fromSealBatchNo,
      reason: body.reason ? String(body.reason) : "",
      operator: body.operator ? String(body.operator).trim() : null,
      supersededOrderId: null,
      changedAt: new Date().toISOString()
    };

    const current = ordersOf(db, clock.id).slice(-1)[0] || null;
    if (current && !current.supersededAt) {
      const changedParts = [
        hasCase ? `壳件批次 ${fromCaseBatchNo ?? "无"}→${toCaseBatchNo}` : null,
        hasSeal ? `密封圈批次 ${fromSealBatchNo ?? "无"}→${toSealBatchNo}` : null
      ].filter(Boolean).join("；");
      current.supersededAt = change.changedAt;
      current.supersededReason = `更换件：${changedParts}，原准入失效需重新压检`;
      current.supersededByChangeId = change.id;
      change.supersededOrderId = current.id;
    }

    clock.caseBatchNo = nextCase;
    clock.sealBatchNo = nextSeal;
    db.componentChanges.push(change);

    return { clock, change };
  });
}

// 登记一张压检记录
async function registerInspection(orderId, body) {
  requireStrings(body, ["inspector"]);
  const inspector = String(body.inspector).trim();
  const metrics = requireInspectionMetrics(body);
  const testedAt = parseTestedAt(body);

  return mutate((db) => {
    const order = findOrder(db, orderId);
    if (order.supersededAt) {
      throw httpError(409, "压检单已作废，不能再登记压检记录", "ORDER_SUPERSEDED");
    }

    const existing = orderedInspections(
      db.pressureInspections.filter((item) => item.orderId === order.id)
    );
    const state = evaluateOrder(order, existing);
    if (state.admitted) {
      throw httpError(409, "该压检单已准入交付，不能再登记压检记录", "ORDER_ALREADY_ADMITTED");
    }

    // 复检须换人：与上一张压检记录同一检验人时拒收，不落库
    const last = existing[existing.length - 1];
    if (last && last.inspector === inspector) {
      throw httpError(422, "复检须换人，检验人不得与上一张压检记录相同", "RETEST_INSPECTOR_SAME", {
        previousInspectionId: last.id,
        inspector
      });
    }

    const now = new Date().toISOString();
    const seq = existing.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
    const inspection = decorateInspection({
      id: makeId("pressure_insp"),
      orderId: order.id,
      clockId: order.clockId,
      seq,
      ...metrics,
      inspector,
      testedAt,
      registeredAt: now,
      note: body.note ? String(body.note) : "",
      correctedAt: null
    });
    db.pressureInspections.push(inspection);

    return { clockId: order.clockId, order, inspection, view: orderView(db, order) };
  });
}

// 更正压检记录：留痕、按更正后数据整体重算；若导致原准入失效并引发批次占用冲突，409 不落库
async function correctInspection(inspectionId, body) {
  requireStrings(body, ["reason"]);

  return mutate((db) => {
    const inspection = findInspection(db, inspectionId);
    const order = findOrder(db, inspection.orderId);

    const providedKeys = Object.keys(body).filter((key) => PATCHABLE_FIELDS.includes(key));
    if (!providedKeys.length) {
      throw httpError(400, `没有可更正的字段，允许字段：${PATCHABLE_FIELDS.join(", ")}`, "NO_PATCH_FIELDS");
    }

    const draft = { ...inspection };
    for (const field of INSPECTION_NUMERIC_FIELDS) {
      if (body[field.key] !== undefined) {
        draft[field.key] = numericValue(body[field.key], field.key, field);
      }
    }
    if (body.inspector !== undefined) {
      if (String(body.inspector).trim() === "") {
        throw httpError(400, "字段 inspector 不能为空", "MISSING_FIELD");
      }
      draft.inspector = String(body.inspector).trim();
    }
    if (body.testedAt !== undefined) draft.testedAt = parseTestedAt(body);
    if (body.note !== undefined) draft.note = String(body.note);

    const corrected = decorateInspection(draft);
    const existing = orderedInspections(
      db.pressureInspections.filter((item) => item.orderId === order.id)
    );
    const beforeState = evaluateOrder(order, existing);
    const hypothetical = evaluateOrder(
      order,
      existing.map((item) => (item.id === inspection.id ? corrected : item))
    );

    // 原本已准入、更正后不再合格 → 压检单重新占用批次；若批次已被别表占用则冲突
    if (beforeState.admitted && !hypothetical.admitted && !order.supersededAt) {
      const conflicts = occupationConflicts(
        db,
        { clockId: order.clockId, caseBatchNo: order.caseBatchNo, sealBatchNo: order.sealBatchNo },
        { reopenFromOrderId: order.id }
      );
      if (conflicts.length) throw conflictError(conflicts);
    }

    const beforeSnapshot = {};
    for (const key of PATCHABLE_FIELDS) beforeSnapshot[key] = inspection[key] ?? null;
    const afterSnapshot = {};
    for (const key of PATCHABLE_FIELDS) afterSnapshot[key] = corrected[key] ?? null;

    Object.assign(inspection, corrected, { correctedAt: new Date().toISOString() });

    const correction = {
      id: makeId("pressure_correction"),
      inspectionId: inspection.id,
      orderId: order.id,
      clockId: order.clockId,
      reason: String(body.reason).trim(),
      operator: body.operator ? String(body.operator).trim() : null,
      changedFields: providedKeys,
      before: beforeSnapshot,
      after: afterSnapshot,
      previousQualified: beforeState.admitted,
      recomputedQualified: hypothetical.admitted,
      admissionInvalidated: beforeState.admitted && !hypothetical.admitted,
      correctedAt: new Date().toISOString()
    };
    db.pressureCorrections.push(correction);

    return { clockId: order.clockId, order, inspection, correction, view: orderView(db, order) };
  });
}

// ---------- HTTP 路由 ----------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const params = url.searchParams;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, {
      ok: true,
      service: "watch-case-pressure-delivery-api",
      routes,
      rules: {
        minDepthMeters: MIN_DEPTH_METERS,
        minHoldMinutes: MIN_HOLD_MINUTES,
        maxLeakBarPerMin: MAX_LEAK_BAR_PER_MIN,
        maxPressureDropBar: MAX_PRESSURE_DROP_BAR,
        admissionIntervalHours: ADMISSION_INTERVAL_MS / 3600000,
        admissionRequires: ["连续两次合格", "间隔至少6小时", "复检换人"]
      }
    });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const db = await readDb();
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    const qualified = params.get("qualified");
    if (qualified !== null) data = data.filter((clock) => clock.qualified === (qualified === "true"));
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    requireStrings(body, ["code", "escapementType", "balanceFrequency"]);
    const result = await mutate((db) => {
      const clock = {
        id: makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        caseBatchNo: body.caseBatchNo ? String(body.caseBatchNo).trim() : null,
        sealBatchNo: body.sealBatchNo ? String(body.sealBatchNo).trim() : null,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.clocks.push(clock);
      return clock;
    });
    const db = await readDb();
    return send(res, 201, { data: clockSummary(db, result) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const db = await readDb();
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  // 交付准入台：列表/状态均与单表历史共用 deliveryForClock 推导
  if (req.method === "GET" && pathname === "/delivery-board") {
    const db = await readDb();
    let data = db.clocks.map((clock) => {
      const summary = clockSummary(db, clock);
      return {
        clockId: clock.id,
        code: clock.code,
        caseBatchNo: summary.caseBatchNo,
        sealBatchNo: summary.sealBatchNo,
        delivery: summary.delivery
      };
    });
    const status = params.get("status");
    if (status !== null) data = data.filter((item) => item.delivery.status === status);
    const admitted = params.get("admitted");
    if (admitted !== null) data = data.filter((item) => item.delivery.admitted === (admitted === "true"));
    return send(res, 200, {
      data,
      summary: {
        total: data.length,
        admitted: data.filter((item) => item.delivery.admitted).length,
        pendingRetest: data.filter((item) => item.delivery.status === "pending_retest").length
      }
    });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const db = await readDb();
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    const componentChanges = db.componentChanges.filter((item) => item.clockId === clock.id);
    const pressureOrders = ordersOf(db, clock.id).map((order) => orderView(db, order));
    return send(res, 200, {
      data: {
        clock,
        adjustments,
        retests,
        latestRetest: latestRetest(db, clock.id),
        componentChanges,
        pressureOrders,
        delivery: deliveryForClock(db, clock)
      }
    });
  }

  const deliveryMatch = pathname.match(/^\/clocks\/([^/]+)\/delivery$/);
  if (deliveryMatch && req.method === "GET") {
    const db = await readDb();
    const clock = findClock(db, deliveryMatch[1]);
    const current = rules.currentEvaluation(db, clock.id);
    return send(res, 200, {
      data: {
        delivery: deliveryForClock(db, clock),
        currentOrder: current ? orderView(db, current.order) : null
      }
    });
  }

  const componentChangeMatch = pathname.match(/^\/clocks\/([^/]+)\/component-change$/);
  if (componentChangeMatch && req.method === "POST") {
    const body = await parseBody(req);
    const { clock, change } = await registerComponentChange(componentChangeMatch[1], body);
    const db = await readDb();
    return send(res, 201, {
      data: change,
      clock: clockSummary(db, clock),
      delivery: deliveryForClock(db, clock)
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = await mutate((db) => {
      const clock = findClock(db, adjustmentMatch[1]);
      const record = {
        id: makeId("adjustment"),
        clockId: clock.id,
        currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.adjustments.push(record);
      return record;
    });
    return send(res, 201, { data: adjustment });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const result = await mutate((db) => {
      const clock = findClock(db, retestMatch[1]);
      const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
      const qualified = body.qualified !== undefined
        ? Boolean(body.qualified)
        : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
      const retest = {
        id: makeId("retest"),
        clockId: clock.id,
        adjustmentId,
        testedAt: body.testedAt || new Date().toISOString(),
        dailyRateSeconds: Number(body.dailyRateSeconds),
        amplitude: Number(body.amplitude),
        qualified,
        note: body.note || ""
      };
      db.retests.push(retest);
      return { clock, retest };
    });
    const db = await readDb();
    return send(res, 201, { data: result.retest, clock: clockSummary(db, result.clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    const db = await readDb();
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  const clockOrdersMatch = pathname.match(/^\/clocks\/([^/]+)\/pressure-orders$/);
  if (clockOrdersMatch && req.method === "GET") {
    const db = await readDb();
    findClock(db, clockOrdersMatch[1]);
    const data = ordersOf(db, clockOrdersMatch[1]).map((order) => orderView(db, order));
    return send(res, 200, { data });
  }
  if (clockOrdersMatch && req.method === "POST") {
    const body = await parseBody(req);
    const { clock, view } = await openPressureOrder(clockOrdersMatch[1], body);
    const db = await readDb();
    return send(res, 201, { data: view, delivery: deliveryForClock(db, clock) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const db = await readDb();
    const clockId = params.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const db = await readDb();
    const clockId = params.get("clockId");
    const qualified = params.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/pressure-orders") {
    const db = await readDb();
    const clockId = params.get("clockId");
    const status = params.get("status");
    let data = db.pressureOrders
      .filter((order) => !clockId || order.clockId === clockId)
      .map((order) => orderView(db, order));
    if (status !== null) data = data.filter((view) => view.state.phase === status);
    return send(res, 200, { data });
  }

  const orderMatch = pathname.match(/^\/pressure-orders\/([^/]+)$/);
  if (orderMatch && req.method === "GET") {
    const db = await readDb();
    const order = findOrder(db, orderMatch[1]);
    return send(res, 200, { data: orderView(db, order) });
  }

  const inspectionCreateMatch = pathname.match(/^\/pressure-orders\/([^/]+)\/inspections$/);
  if (inspectionCreateMatch && req.method === "POST") {
    const body = await parseBody(req);
    const result = await registerInspection(inspectionCreateMatch[1], body);
    const db = await readDb();
    return send(res, 201, {
      data: result.inspection,
      order: orderView(db, result.order),
      delivery: deliveryForClock(db, db.clocks.find((clock) => clock.id === result.clockId))
    });
  }

  if (req.method === "GET" && pathname === "/pressure-inspections") {
    const db = await readDb();
    const orderId = params.get("orderId");
    const clockId = params.get("clockId");
    const data = db.pressureInspections
      .filter((item) => (!orderId || item.orderId === orderId) && (!clockId || item.clockId === clockId))
      .map(decorateInspection)
      .sort((a, b) => a.seq - b.seq);
    return send(res, 200, { data });
  }

  const inspectionPatchMatch = pathname.match(/^\/pressure-inspections\/([^/]+)$/);
  if (inspectionPatchMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const result = await correctInspection(inspectionPatchMatch[1], body);
    const db = await readDb();
    return send(res, 200, {
      data: result.inspection,
      correction: result.correction,
      order: orderView(db, result.order),
      delivery: deliveryForClock(db, db.clocks.find((clock) => clock.id === result.clockId))
    });
  }

  if (req.method === "GET" && pathname === "/component-changes") {
    const db = await readDb();
    const clockId = params.get("clockId");
    const data = db.componentChanges.filter((item) => !clockId || item.clockId === clockId);
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/pressure-corrections") {
    const db = await readDb();
    const clockId = params.get("clockId");
    const orderId = params.get("orderId");
    const data = db.pressureCorrections.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchOrder = !orderId || item.orderId === orderId;
      return matchClock && matchOrder;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`, "MISSING_FIELD");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    send(res, error.status || 500, {
      error: error.message || "服务器错误",
      code: error.code || null,
      ...(error.conflicts ? { conflicts: error.conflicts } : {}),
      ...(error.previousInspectionId ? { previousInspectionId: error.previousInspectionId } : {})
    });
  });
});

module.exports = { server, routes, handle };
