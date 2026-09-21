# 表壳防水压检与交付准入台（含机械钟表擒纵调校）

纯后端零依赖 Node 服务。原有擒纵调校能力保留，新增表壳防水压检与交付准入闭环。

## 三个业务模块

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 入口 | `lib/entry.js` | HTTP 路由、参数校验、请求编排；冲突返回 409 且不落库 |
| 判定规则 | `lib/rules.js` | 纯函数：合格判定、复检换人、六小时间隔、准入/失效实时重算 |
| 档案存储 | `lib/archive.js` | `data/db.json` 读写、集合自动补齐、写操作串行化 |

`server.js` 仅负责启动引导。列表、单表历史与交付台共用同一推导函数 `deliveryForClock`，状态天然一致；准入结论不入库，任何更正都在读取时按新数据重算。

## 启动

```bash
PORT=3021 node server.js
```

## 压检判定规则

- 单次压检登记：目标深度（米）、保压时长（分钟）、初压、末压（巴）、泄漏量（巴/分钟）、检验人。
- 以下任一不满足，该次不合格，压检单只转**待复检**：
  - 目标深度 `< 100` 米
  - 保压时长 `< 30` 分钟
  - 泄漏量 `> 0.05` 巴/分钟
  - 末压下降（初压 − 末压）`> 0.3` 巴
- 复检**必须换人**（与上一张压检记录检验人不同，否则 `422` 拒收）。
- **连续两次合格**且两次检验**间隔 ≥ 6 小时**、检验人不同，才准许交付；单次合格为“待第二次合格确认”。
- 每只表只能有一张未结束压检单；壳件批次、密封圈批次被在途单占用时，开单返回 `409` 且不写库。
- 更换壳件/密封圈（`POST /clocks/:id/component-change`）：原压检单立即作废、原准入失效、旧批次释放，需按新批次重新压检。
- 更正压检记录（`PATCH /pressure-inspections/:id`，须填更正原因）：留痕并按更正后数据整体重算；若原准入失效后重占批次与别表冲突，返回 `409` 且不更正、不留痕。

压检单状态：`testing`（压检中）/ `pending_retest`（待复检）/ `awaiting_second`（待第二次合格确认）/ `admitted`（准许交付）/ `superseded`（已作废）。

## 接口

原有调校：

- `GET /health`
- `GET /clocks` · `POST /clocks`（可带 `caseBatchNo`、`sealBatchNo`）
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（含换件痕迹、全部压检单与交付状态）
- `POST /clocks/:id/adjustments` · `POST /clocks/:id/retests` · `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=` · `GET /retests?clockId=&qualified=`

压检与交付：

- `GET /delivery-board?status=&admitted=` 交付准入台
- `GET /clocks/:id/delivery` 单表交付状态
- `POST /clocks/:id/component-change` 更换壳件/密封圈
- `GET|POST /clocks/:id/pressure-orders`
- `GET /pressure-orders?clockId=&status=` · `GET /pressure-orders/:orderId`
- `POST /pressure-orders/:orderId/inspections` 登记压检
- `GET /pressure-inspections?orderId=&clockId=`
- `PATCH /pressure-inspections/:inspectionId` 更正压检记录（须带 `reason`）
- `GET /component-changes?clockId=` · `GET /pressure-corrections?clockId=&orderId=`

## 闭环示例

```bash
# 开压检单（批次被占用/已有在途单时 409）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/pressure-orders \
  -H 'Content-Type: application/json' \
  -d '{"caseBatchNo":"CASE-A01","sealBatchNo":"SEAL-B07"}'

# 首检不合格 → 待复检
curl -X POST http://127.0.0.1:3021/pressure-orders/<orderId>/inspections \
  -H 'Content-Type: application/json' \
  -d '{"targetDepthM":80,"holdMinutes":20,"initialBar":5,"finalBar":4.5,"leakBarPerMin":0.1,"inspector":"张师傅"}'

# 换人复检合格后，还需间隔≥6小时的第二次合格才能准入
curl -X POST http://127.0.0.1:3021/pressure-orders/<orderId>/inspections \
  -H 'Content-Type: application/json' \
  -d '{"targetDepthM":120,"holdMinutes":40,"initialBar":5,"finalBar":4.95,"leakBarPerMin":0.02,"inspector":"李师傅"}'

curl http://127.0.0.1:3021/delivery-board
```
