"use strict";

// 端到端业务测试：独立临时档案 + 随机端口起服务，覆盖全部压检/准入规则。
const test = require("node:test");
const assert = require("node:assert");
const { once } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const { rm } = require("node:fs/promises");

const TMP_DB = path.join(os.tmpdir(), `pressure-test-${process.pid}-${Date.now()}.json`);
process.env.DB_FILE = TMP_DB;
delete require.cache[require.resolve("../server")];
const { server } = require("../server");

async function start() {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function api(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}

const PASS_BODY = (testedAt, inspector) => ({
  targetDepthMeters: 150,
  holdMinutes: 45,
  startPressureBar: 5,
  endPressureBar: 4.9, // 下降 0.1 巴
  leakRateBarPerMin: 0.01,
  inspector,
  testedAt,
  note: "合格压检"
});

async function createClock(base, code) {
  const res = await api(base, "POST", "/clocks", {
    code,
    escapementType: "同轴擒纵",
    balanceFrequency: "28800vph"
  });
  assert.equal(res.status, 201);
  return res.json.data.id;
}

let BASE;

test.before(async () => {
  BASE = await start();
});

test.after(async () => {
  server.close();
  await rm(TMP_DB, { force: true });
});

test("健康检查与建档", async () => {
  const health = await api(BASE, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.service, "watch-pressure-delivery-api");
  const id = await createClock(BASE, "T-001");
  assert.ok(id);
});

test("每只表只能有一张未结束压检单，重复开立返回409且不落库", async () => {
  const clockId = await createClock(BASE, "T-OPEN");
  const first = await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
    caseBatch: "CASE-A",
    sealBatch: "SEAL-A"
  });
  assert.equal(first.status, 201);
  assert.equal(first.json.data.status, "open");
  assert.equal(first.json.data.deliveryStatus, "awaiting_first");

  const second = await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
    caseBatch: "CASE-X",
    sealBatch: "SEAL-X"
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.code, "open_order");

  const list = await api(BASE, "GET", `/clocks/${clockId}/pressure-orders`);
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.data[0].caseBatch, "CASE-A");
});

test("壳件批次/密封圈批次被未结束单占用时409且不落库（两种批次独立判定）", async () => {
  const c1 = await createClock(BASE, "T-B1");
  const r1 = await api(BASE, "POST", `/clocks/${c1}/pressure-orders`, {
    caseBatch: "CASE-SHARED",
    sealBatch: "SEAL-OWN-1"
  });
  assert.equal(r1.status, 201);

  const c2 = await createClock(BASE, "T-B2");
  const conflictCase = await api(BASE, "POST", `/clocks/${c2}/pressure-orders`, {
    caseBatch: "CASE-SHARED",
    sealBatch: "SEAL-OWN-2"
  });
  assert.equal(conflictCase.status, 409);
  assert.equal(conflictCase.json.code, "caseBatch");
  assert.equal(conflictCase.json.occupiedBy, r1.json.data.id);

  const c3 = await createClock(BASE, "T-B3");
  const r3 = await api(BASE, "POST", `/clocks/${c3}/pressure-orders`, {
    caseBatch: "CASE-OWN-3",
    sealBatch: "SEAL-SHARED"
  });
  assert.equal(r3.status, 201);

  const c4 = await createClock(BASE, "T-B4");
  const conflictSeal = await api(BASE, "POST", `/clocks/${c4}/pressure-orders`, {
    caseBatch: "CASE-OWN-4",
    sealBatch: "SEAL-SHARED"
  });
  assert.equal(conflictSeal.status, 409);
  assert.equal(conflictSeal.json.code, "sealBatch");

  // 409 不落库：冲突表下没有压检单
  assert.equal((await api(BASE, "GET", `/clocks/${c2}/pressure-orders`)).json.data.length, 0);
  assert.equal((await api(BASE, "GET", `/clocks/${c4}/pressure-orders`)).json.data.length, 0);
});

test("单次压检四类不合格条件只转待复检", async () => {
  const clockId = await createClock(BASE, "T-FAIL");
  const orderId = (
    await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
      caseBatch: "CASE-F",
      sealBatch: "SEAL-F"
    })
  ).json.data.id;

  const shallow = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    Object.assign(PASS_BODY("2026-09-20T00:00:00.000Z", "甲"), { targetDepthMeters: 99 })
  );
  assert.equal(shallow.status, 201);
  assert.equal(shallow.json.data.result, "fail");
  assert.match(shallow.json.data.failReasons[0], /不足 100 米/);
  assert.equal(shallow.json.order.deliveryStatus, "awaiting_retest");
  assert.deepEqual(shallow.json.order.deliveryBlockers.slice(0, 1), ["末次压检不合格，转待复检"]);

  const shortHold = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    Object.assign(PASS_BODY("2026-09-20T01:00:00.000Z", "乙"), { holdMinutes: 29 })
  );
  assert.equal(shortHold.json.data.result, "fail");
  assert.match(shortHold.json.data.failReasons[0], /不足 30 分钟/);

  const leaky = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    Object.assign(PASS_BODY("2026-09-20T02:00:00.000Z", "甲"), { leakRateBarPerMin: 0.06 })
  );
  assert.equal(leaky.json.data.result, "fail");
  assert.match(leaky.json.data.failReasons[0], /0.05/);

  const dropTooMuch = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    Object.assign(PASS_BODY("2026-09-20T03:00:00.000Z", "乙"), {
      startPressureBar: 5,
      endPressureBar: 4.6
    })
  );
  assert.equal(dropTooMuch.json.data.result, "fail");
  assert.match(dropTooMuch.json.data.failReasons[0], /末压下降 0.40 巴/);
});

test("复检须换人：同人登记400", async () => {
  const clockId = await createClock(BASE, "T-REINSPECT");
  const orderId = (
    await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
      caseBatch: "CASE-RI",
      sealBatch: "SEAL-RI"
    })
  ).json.data.id;

  const first = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    Object.assign(PASS_BODY("2026-09-20T00:00:00.000Z", "张三"), {
      leakRateBarPerMin: 0.2
    })
  );
  assert.equal(first.status, 201);
  assert.equal(first.json.data.result, "fail");

  const samePerson = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    PASS_BODY("2026-09-20T02:00:00.000Z", "张三")
  );
  assert.equal(samePerson.status, 400);
  assert.equal(samePerson.json.code, "same_inspector");
  // 拒绝登记，不落库：仍只有一条记录，状态仍待复检
  const order = (await api(BASE, "GET", `/pressure-orders/${orderId}`)).json.data;
  assert.equal(order.tests.length, 1);
  assert.equal(order.deliveryStatus, "awaiting_retest");
  assert.match(order.deliveryBlockers.join(";"), /复检须换人/);
});

test("连续两次合格但间隔不足6小时不准入；间隔≥6小时且换人才准入", async () => {
  const clockId = await createClock(BASE, "T-ADMIT");
  const orderId = (
    await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
      caseBatch: "CASE-ADM",
      sealBatch: "SEAL-ADM"
    })
  ).json.data.id;

  const t1 = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    PASS_BODY("2026-09-20T00:00:00.000Z", "甲")
  );
  assert.equal(t1.json.data.result, "pass");
  assert.equal(t1.json.order.admitted, false);

  const t2soon = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    PASS_BODY("2026-09-20T05:59:00.000Z", "乙")
  );
  assert.equal(t2soon.status, 201);
  assert.equal(t2soon.json.order.deliveryStatus, "in_progress");
  assert.match(t2soon.json.order.deliveryBlockers.join(";"), /至少 6 小时/);

  // 第三次与第二次间隔仍不足6小时（连续两次口径，不累计）
  const t3 = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    PASS_BODY("2026-09-20T11:58:00.000Z", "甲")
  );
  assert.equal(t3.json.order.deliveryStatus, "in_progress");
  assert.match(t3.json.order.deliveryBlockers.join(";"), /至少 6 小时/);

  // 第四次：与第三次间隔 6 小时 2 分，且换人 -> 准入
  const t4 = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    PASS_BODY("2026-09-20T18:00:00.000Z", "乙")
  );
  assert.equal(t4.status, 201);
  assert.equal(t4.json.order.admitted, true);
  assert.equal(t4.json.order.deliveryStatus, "admitted");
  assert.deepEqual(t4.json.order.deliveryBlockers, []);
  assert.equal(t4.json.order.admission.basis.firstTestId, t3.json.data.id);
  assert.equal(t4.json.order.admission.basis.secondTestId, t4.json.data.id);

  // 交付状态接口与列表一致
  const delivery = (await api(BASE, "GET", `/clocks/${clockId}/delivery`)).json.data;
  assert.equal(delivery.admitted, true);
  assert.equal(delivery.status, "admitted");
  assert.equal(delivery.rule.recheckGapHours, 6);
});

test("准入后新增不合格压检：原准入失效，转待复检", async () => {
  const clockId = await createClock(BASE, "T-INVALIDATE");
  const orderId = (
    await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
      caseBatch: "CASE-INV",
      sealBatch: "SEAL-INV"
    })
  ).json.data.id;

  await api(BASE, "POST", `/pressure-orders/${orderId}/tests`, PASS_BODY("2026-09-20T00:00:00.000Z", "甲"));
  await api(BASE, "POST", `/pressure-orders/${orderId}/tests`, PASS_BODY("2026-09-20T07:00:00.000Z", "乙"));
  let order = (await api(BASE, "GET", `/pressure-orders/${orderId}`)).json.data;
  assert.equal(order.admitted, true);
  assert.equal(order.tests.length, 2);

  const bad = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    Object.assign(PASS_BODY("2026-09-21T00:00:00.000Z", "甲"), { leakRateBarPerMin: 0.09 })
  );
  assert.equal(bad.json.data.result, "fail");
  assert.equal(bad.json.order.deliveryStatus, "awaiting_retest");
  assert.equal(bad.json.order.admitted, false);

  // 准入档案留痕：valid -> invalid
  const history = (await api(BASE, "GET", `/clocks/${clockId}/history`)).json.data;
  const admissions = history.admissions;
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].status, "invalid");
  assert.match(admissions[0].invalidReason, /不合格/);
  assert.ok(admissions[0].invalidatedAt);
});

test("准入后更正压检记录：缺原因400；更正后原准入失效并按新数据重算", async () => {
  const clockId = await createClock(BASE, "T-CORRECT");
  const orderId = (
    await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
      caseBatch: "CASE-COR",
      sealBatch: "SEAL-COR"
    })
  ).json.data.id;

  const t1 = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    PASS_BODY("2026-09-20T00:00:00.000Z", "甲")
  );
  const t2 = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    PASS_BODY("2026-09-20T08:00:00.000Z", "乙")
  );
  assert.equal(t2.json.order.admitted, true);

  const noReason = await api(BASE, "PATCH", `/pressure-orders/${orderId}/tests/${t2.json.data.id}`, {
    leakRateBarPerMin: 0.01
  });
  assert.equal(noReason.status, 400);
  assert.match(noReason.json.error, /缺少字段：reason/);

  // 把第一次合格更正为不合格 -> 连续两次合格被打破 -> 准入失效
  const corrected = await api(
    BASE,
    "PATCH",
    `/pressure-orders/${orderId}/tests/${t1.json.data.id}`,
    { targetDepthMeters: 80, reason: "深度登记错误" }
  );
  assert.equal(corrected.status, 200);
  assert.equal(corrected.json.data.result, "fail");
  assert.equal(corrected.json.data.corrections.length, 1);
  assert.equal(corrected.json.data.corrections[0].before.targetDepthMeters, 150);
  assert.equal(corrected.json.order.deliveryStatus, "admission_invalid");
  assert.equal(corrected.json.order.admitted, false);
  assert.match(corrected.json.order.deliveryBlockers.join(";"), /失效/);

  // 列表过滤 admitted=true 不再包含该表；交付状态同步
  const admittedList = await api(BASE, "GET", "/clocks?admitted=true");
  assert.ok(!admittedList.json.data.some((item) => item.id === clockId));
  const delivery = (await api(BASE, "GET", `/clocks/${clockId}/delivery`)).json.data;
  assert.equal(delivery.status, "admission_invalid");
  assert.equal(delivery.admitted, false);
});

test("更正后新数据仍满足连续两次合格：失效旧准入并签发新准入", async () => {
  const clockId = await createClock(BASE, "T-READMIT");
  const orderId = (
    await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
      caseBatch: "CASE-RA",
      sealBatch: "SEAL-RA"
    })
  ).json.data.id;

  const t1 = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    PASS_BODY("2026-09-20T00:00:00.000Z", "甲")
  );
  const t2 = await api(
    BASE,
    "POST",
    `/pressure-orders/${orderId}/tests`,
    PASS_BODY("2026-09-20T08:00:00.000Z", "乙")
  );
  assert.equal(t2.json.order.admitted, true);

  // 更正备注不影响判定，但仍按规则重算并保留准入
  const fixed = await api(BASE, "PATCH", `/pressure-orders/${orderId}/tests/${t1.json.data.id}`, {
    note: "补设备编号",
    reason: "登记时漏填设备"
  });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.json.order.admitted, true);

  // 更正第二次的时间，使两次间隔不足6小时 -> 准入失效
  const broken = await api(
    BASE,
    "PATCH",
    `/pressure-orders/${orderId}/tests/${t2.json.data.id}`,
    { testedAt: "2026-09-20T02:00:00.000Z", reason: "时间记错" }
  );
  assert.equal(broken.json.order.admitted, false);
  assert.match(broken.json.order.deliveryBlockers.join(";"), /至少 6 小时/);

  // 再更正回 8 小时后 -> 重新准入（新档案）
  const restored = await api(
    BASE,
    "PATCH",
    `/pressure-orders/${orderId}/tests/${t2.json.data.id}`,
    { testedAt: "2026-09-20T08:00:00.000Z", reason: "时间再次核对" }
  );
  assert.equal(restored.json.order.admitted, true);

  const history = (await api(BASE, "GET", `/clocks/${clockId}/history`)).json.data;
  const valid = history.admissions.filter((item) => item.status === "valid");
  const invalid = history.admissions.filter((item) => item.status === "invalid");
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 1);
  assert.equal(history.delivery.admitted, true);
});

test("更换壳件/密封圈：批次冲突409不落库；换件后旧准入失效、旧记录不计入新准入", async () => {
  const c1 = await createClock(BASE, "T-SWAP-1");
  const order1 = (
    await api(BASE, "POST", `/clocks/${c1}/pressure-orders`, {
      caseBatch: "CASE-OLD",
      sealBatch: "SEAL-OLD"
    })
  ).json.data;
  await api(BASE, "POST", `/pressure-orders/${order1.id}/tests`, PASS_BODY("2026-09-20T00:00:00.000Z", "甲"));
  await api(BASE, "POST", `/pressure-orders/${order1.id}/tests`, PASS_BODY("2026-09-20T07:00:00.000Z", "乙"));
  assert.equal((await api(BASE, "GET", `/pressure-orders/${order1.id}`)).json.data.admitted, true);

  // 另一只表占用 CASE-NEW
  const c2 = await createClock(BASE, "T-SWAP-2");
  await api(BASE, "POST", `/clocks/${c2}/pressure-orders`, {
    caseBatch: "CASE-NEW",
    sealBatch: "SEAL-NEW"
  });

  const conflict = await api(BASE, "PATCH", `/pressure-orders/${order1.id}`, {
    caseBatch: "CASE-NEW",
    changeReason: "壳件瑕疵更换"
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "caseBatch");
  // 409 不落库：批次未变、准入仍有效
  const unchanged = (await api(BASE, "GET", `/pressure-orders/${order1.id}`)).json.data;
  assert.equal(unchanged.caseBatch, "CASE-OLD");
  assert.equal(unchanged.admitted, true);

  // 换成未占用的批次：准入立即失效，两次旧合格因批次快照不同不再计入
  const swapped = await api(BASE, "PATCH", `/pressure-orders/${order1.id}`, {
    caseBatch: "CASE-FRESH",
    sealBatch: "SEAL-FRESH",
    changeReason: "壳件与密封圈整体更换"
  });
  assert.equal(swapped.status, 200);
  assert.equal(swapped.json.data.caseBatch, "CASE-FRESH");
  assert.equal(swapped.json.data.deliveryStatus, "admission_invalid");
  assert.match(swapped.json.data.deliveryBlockers.join(";"), /失效/);
  assert.match(swapped.json.data.deliveryBlockers.join(";"), /连续两次合格/);
  assert.equal(swapped.json.data.tests.length, 2);

  // 新批次下重新完成两次合格（换人+6小时）-> 重新准入
  const r1 = await api(
    BASE,
    "POST",
    `/pressure-orders/${order1.id}/tests`,
    PASS_BODY("2026-09-21T00:00:00.000Z", "丙")
  );
  assert.equal(r1.json.data.caseBatch, "CASE-FRESH");
  const r2 = await api(
    BASE,
    "POST",
    `/pressure-orders/${order1.id}/tests`,
    PASS_BODY("2026-09-21T06:30:00.000Z", "丁")
  );
  assert.equal(r2.json.order.admitted, true);

  // 结束后释放批次占用：别的表可以再用
  const closed = await api(BASE, "POST", `/pressure-orders/${order1.id}/close`, {});
  assert.equal(closed.status, 200);
  assert.equal(closed.json.data.status, "closed");
  assert.equal(closed.json.data.deliveryStatus, "closed_admitted");
});

test("结束的单子释放批次占用，且不可再登记/更正/换件", async () => {
  const c1 = await createClock(BASE, "T-CLOSE-1");
  const order1 = (
    await api(BASE, "POST", `/clocks/${c1}/pressure-orders`, {
      caseBatch: "CASE-CLOSE-A",
      sealBatch: "SEAL-CLOSE-A"
    })
  ).json.data;
  await api(BASE, "POST", `/pressure-orders/${order1.id}/close`, {});

  const add = await api(
    BASE,
    "POST",
    `/pressure-orders/${order1.id}/tests`,
    PASS_BODY("2026-09-20T00:00:00.000Z", "甲")
  );
  assert.equal(add.status, 409);
  assert.equal(add.json.code, "order_closed");

  const patchOrder = await api(BASE, "PATCH", `/pressure-orders/${order1.id}`, {
    caseBatch: "OTHER"
  });
  assert.equal(patchOrder.status, 409);

  // 批次已被释放：新表可占用
  const c2 = await createClock(BASE, "T-CLOSE-2");
  const reuse = await api(BASE, "POST", `/clocks/${c2}/pressure-orders`, {
    caseBatch: "CASE-CLOSE-A",
    sealBatch: "SEAL-CLOSE-A"
  });
  assert.equal(reuse.status, 201);
});

test("未准入即结束：交付状态为已结束未准入；列表/历史/交付状态一致", async () => {
  const clockId = await createClock(BASE, "T-CLOSED-NOADMIT");
  const orderId = (
    await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
      caseBatch: "CASE-CN",
      sealBatch: "SEAL-CN"
    })
  ).json.data.id;
  await api(BASE, "POST", `/pressure-orders/${orderId}/close`, {});

  const order = (await api(BASE, "GET", `/pressure-orders/${orderId}`)).json.data;
  assert.equal(order.deliveryStatus, "closed");
  assert.equal(order.admitted, false);

  const delivery = (await api(BASE, "GET", `/clocks/${clockId}/delivery`)).json.data;
  assert.equal(delivery.status, "closed");
  assert.equal(delivery.admitted, false);

  const history = (await api(BASE, "GET", `/clocks/${clockId}/history`)).json.data;
  assert.equal(history.pressureOrders[0].deliveryStatus, "closed");
  assert.equal(history.delivery.status, "closed");

  const listItem = (await api(BASE, "GET", "/clocks")).json.data.find((item) => item.id === clockId);
  assert.equal(listItem.deliveryStatus, "closed");
  assert.equal(listItem.admitted, false);
});

test("阈值边界：100米/30分钟/0.05/0.3 均合格", async () => {
  const clockId = await createClock(BASE, "T-BOUNDARY");
  const orderId = (
    await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
      caseBatch: "CASE-BD",
      sealBatch: "SEAL-BD"
    })
  ).json.data.id;
  const t1 = await api(BASE, "POST", `/pressure-orders/${orderId}/tests`, {
    targetDepthMeters: 100,
    holdMinutes: 30,
    startPressureBar: 5,
    endPressureBar: 4.7, // 恰好下降 0.3
    leakRateBarPerMin: 0.05, // 恰好 0.05
    inspector: "边界甲",
    testedAt: "2026-09-20T00:00:00.000Z"
  });
  assert.equal(t1.json.data.result, "pass");
  assert.equal(t1.json.data.pressureDropBar, 0.3);
});

test("非法输入与不存在资源", async () => {
  const badJson = await fetch(BASE + "/clocks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json"
  });
  assert.equal(badJson.status, 400);

  const missing = await api(BASE, "POST", "/clocks/nope/pressure-orders", {
    caseBatch: "X",
    sealBatch: "Y"
  });
  assert.equal(missing.status, 404);

  const clockId = await createClock(BASE, "T-BADINPUT");
  const orderId = (
    await api(BASE, "POST", `/clocks/${clockId}/pressure-orders`, {
      caseBatch: "CASE-BI",
      sealBatch: "SEAL-BI"
    })
  ).json.data.id;
  const badNumber = await api(BASE, "POST", `/pressure-orders/${orderId}/tests`, {
    targetDepthMeters: "深",
    holdMinutes: 30,
    startPressureBar: 5,
    endPressureBar: 5,
    leakRateBarPerMin: 0,
    inspector: "甲"
  });
  assert.equal(badNumber.status, 400);
  assert.match(badNumber.json.error, /数字/);

  const notFoundRoute = await api(BASE, "GET", "/nope");
  assert.equal(notFoundRoute.status, 404);
});
