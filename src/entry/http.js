"use strict";

// 入口模块：HTTP 收发与通用参数校验，不含业务判定。
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function httpError(status, message, extra) {
  const error = new Error(message);
  error.status = status;
  error.extras = extra || {};
  if (!error.extras.code && extra && extra.conflict) error.extras.code = extra.conflict;
  return error;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
}

function numberField(body, field, { integer = false, min, allowNegative = false } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === "") {
    throw httpError(400, `缺少字段：${field}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw httpError(400, `字段 ${field} 必须是数字`);
  if (integer && !Number.isInteger(value)) throw httpError(400, `字段 ${field} 必须是整数`);
  if (!allowNegative && value < 0) throw httpError(400, `字段 ${field} 不能为负`);
  if (min !== undefined && value < min) throw httpError(400, `字段 ${field} 不得小于 ${min}`);
  return value;
}

function stringField(body, field) {
  const value = body[field];
  if (value === undefined || value === null || String(value).trim() === "") {
    throw httpError(400, `缺少字段：${field}`);
  }
  return String(value).trim();
}

function parseTimestamp(value, fallback) {
  const ts = value ? new Date(value) : new Date(fallback);
  if (isNaN(ts.getTime())) throw httpError(400, "时间字段格式不合法");
  return ts.toISOString();
}

module.exports = { send, parseBody, httpError, required, numberField, stringField, parseTimestamp };
