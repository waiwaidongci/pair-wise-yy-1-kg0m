"use strict";

// 服务装配层：HTTP 入口 → 路由分发 → 业务处理器（判定规则 / 档案存储均在 src 下）。
const http = require("http");
const store = require("./src/archive/store");
const { send, parseBody } = require("./src/entry/http");
const tuningHandlers = require("./src/entry/tuning");
const pressureHandlers = require("./src/entry/pressure");

const PORT = Number(process.env.PORT || 3021);

const routes = [
  // 原走时调校
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  // 表壳防水压检与交付准入
  "POST /clocks/:id/pressure-orders",
  "GET /clocks/:id/pressure-orders",
  "GET /clocks/:id/delivery",
  "GET /pressure-orders",
  "GET /pressure-orders/:orderId",
  "PATCH /pressure-orders/:orderId",
  "POST /pressure-orders/:orderId/close",
  "POST /pressure-orders/:orderId/tests",
  "PATCH /pressure-orders/:orderId/tests/:testId",
  "GET /pressure-tests"
];

// 简单参数化路由：静态段优先于 :参数 段
function matchRoute(method, pathname) {
  for (const definition of routes) {
    const [defMethod, defPath] = definition.split(" ");
    if (defMethod !== method) continue;
    const defSegs = defPath.split("/").filter(Boolean);
    const reqSegs = pathname.split("/").filter(Boolean);
    if (defSegs.length !== reqSegs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < defSegs.length; i += 1) {
      if (defSegs[i].startsWith(":")) {
        params[defSegs[i].slice(1)] = decodeURIComponent(reqSegs[i]);
      } else if (defSegs[i] !== reqSegs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { definition, params };
  }
  return null;
}

// 路由 → 处理器（处理器只返回 { status, body }，不接触 res）
async function dispatch(definition, params, query, body) {
  switch (definition) {
    case "GET /clocks":
      return tuningHandlers.listClocks(query);
    case "POST /clocks":
      return tuningHandlers.createClock(body);
    case "GET /clocks/not-qualified":
      return tuningHandlers.notQualifiedClocks();
    case "GET /clocks/:id/history":
      return tuningHandlers.clockHistory({ clockId: params.id });
    case "POST /clocks/:id/adjustments":
      return tuningHandlers.addAdjustment({ clockId: params.id }, body);
    case "POST /clocks/:id/retests":
      return tuningHandlers.addRetest({ clockId: params.id }, body);
    case "GET /clocks/:id/latest-retest":
      return tuningHandlers.latestRetest({ clockId: params.id });
    case "GET /adjustments":
      return tuningHandlers.listAdjustments(query);
    case "GET /retests":
      return tuningHandlers.listRetests(query);

    case "POST /clocks/:id/pressure-orders":
      return pressureHandlers.createOrder({ clockId: params.id }, body);
    case "GET /clocks/:id/pressure-orders":
      return pressureHandlers.listOrdersForClock({ clockId: params.id });
    case "GET /clocks/:id/delivery":
      return pressureHandlers.delivery({ clockId: params.id });
    case "GET /pressure-orders":
      return pressureHandlers.listOrders(query);
    case "GET /pressure-orders/:orderId":
      return pressureHandlers.getOrder({ orderId: params.orderId });
    case "PATCH /pressure-orders/:orderId":
      return pressureHandlers.patchOrder({ orderId: params.orderId }, body);
    case "POST /pressure-orders/:orderId/close":
      return pressureHandlers.closeOrder({ orderId: params.orderId }, body);
    case "POST /pressure-orders/:orderId/tests":
      return pressureHandlers.addTest({ orderId: params.orderId }, body);
    case "PATCH /pressure-orders/:orderId/tests/:testId":
      return pressureHandlers.patchTest(
        { orderId: params.orderId, testId: params.testId },
        body
      );
    case "GET /pressure-tests":
      return pressureHandlers.listTests(query);
    default:
      return null;
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "watch-pressure-delivery-api", routes });
  }

  const matched = matchRoute(req.method, url.pathname);
  if (!matched) return send(res, 404, { error: "接口不存在", routes });

  const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await parseBody(req) : {};
  const query = Object.fromEntries(url.searchParams);
  const result = await dispatch(matched.definition, matched.params, query, body);
  return send(res, result.status, result.body);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, {
      error: error.message || "服务器错误",
      ...(error.extras || {})
    })
  );
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Watch waterproof pressure test & delivery API running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { server, routes, matchRoute, dispatch, store };
