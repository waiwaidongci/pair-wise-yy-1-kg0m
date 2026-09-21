# 机械钟表擒纵调校 + 表壳防水压检与交付准入 API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化档案。在原走时调校 API 基础上，
扩展为**表壳防水压检与交付准入台**，并按三个业务模块拆分：

| 业务模块 | 目录 | 职责 |
| --- | --- | --- |
| 入口模块 | `src/entry/` | HTTP 收发、取参与校验、路由分发、组装响应 |
| 判定规则模块 | `src/rules/` | 压检合格判定、复检换人/间隔、批次占用、准入重算（纯函数） |
| 档案存储模块 | `src/archive/` | JSON 档案读取/落盘、旧库结构迁移、ID 生成 |

`server.js` 只做装配与路由分发。

## 启动

```bash
PORT=3021 node server.js
```

## 压检业务规则

- 每只表只能有**一张未结束压检单**，重复开立返回 `409` 且不落库。
- **壳件批次**与**密封圈批次**分别占用：被任一未结束压检单占用时，新开单/换件返回 `409`，
  冲突信息包含占用单号；压检单结束后释放占用。所有冲突均在写库前判定，失败不落库。
- 每次压检登记：目标深度、保压时长、初压、末压、泄漏量、检验人（自动计算末压下降）。
- 单次压检有下列任一情况即不合格，只转**待复检**：
  - 目标深度不足 100 米
  - 保压不足 30 分钟
  - 泄漏量超过 0.05 巴/分钟
  - 末压下降（初压−末压）超过 0.3 巴
- **复检须换人**：首张之后的每次登记，检验人不得与上一张相同，否则 `400`。
- **准入条件**：当前壳件/密封圈批次下连续两次合格，且两次间隔至少 6 小时。
- **更换壳件/密封圈**或**更正压检记录**：原准入立即失效（准入档案留痕 `valid → invalid`），
  按更正后的新数据/新批次重新核算；换件前的旧压检因批次快照不同，不计入新准入。
- 交付状态（`awaiting_first 待首检 / in_progress 检验中 / awaiting_retest 待复检 /
  admitted 已准入 / admission_invalid 准入失效 / closed* 已结束`）只由
  `src/rules/pressure.js` 的同一函数计算，**列表、单表历史、交付状态接口永远一致**。

## 接口

### 走时调校（原有）

- `GET /health`
- `GET /clocks`（支持 `?qualified=`，新增 `?admitted=`、`?deliveryStatus=`）
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（含压检单、压检记录、准入档案与交付状态）
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

### 防水压检与交付准入（新增）

- `POST /clocks/:id/pressure-orders` 开压检单（冲突 409）
- `GET /clocks/:id/pressure-orders` 单表压检单列表
- `GET /clocks/:id/delivery` 交付准入状态（含判定口径与阻断原因）
- `GET /pressure-orders?clockId=&status=&admitted=` 压检单列表
- `GET /pressure-orders/:orderId` 单表详情（含全部压检与准入状态）
- `PATCH /pressure-orders/:orderId` 更换壳件/密封圈批次（冲突 409；准入失效重算）
- `POST /pressure-orders/:orderId/close` 结束压检单（释放批次占用）
- `POST /pressure-orders/:orderId/tests` 登记压检
- `PATCH /pressure-orders/:orderId/tests/:testId` 更正压检记录（必带 `reason`，留痕）
- `GET /pressure-tests?orderId=&clockId=&result=pass|fail`

## 准入闭环示例

```bash
# 两次合格、换人、间隔 6 小时以上
curl -X POST http://127.0.0.1:3021/pressure-orders/$OID/tests \
  -H 'Content-Type: application/json' \
  -d '{"targetDepthMeters":150,"holdMinutes":45,"startPressureBar":5,"endPressureBar":4.9,"leakRateBarPerMin":0.01,"inspector":"赵师傅","testedAt":"2026-09-21T01:00:00Z"}'

curl -X POST http://127.0.0.1:3021/pressure-orders/$OID/tests \
  -H 'Content-Type: application/json' \
  -d '{"targetDepthMeters":150,"holdMinutes":45,"startPressureBar":5,"endPressureBar":4.9,"leakRateBarPerMin":0.01,"inspector":"钱师傅","testedAt":"2026-09-21T08:00:00Z"}'

curl http://127.0.0.1:3021/clocks/$CID/delivery
```

## 测试

```bash
npm test        # node --test test/（使用临时档案与随机端口，不污染 data/db.json）
```
