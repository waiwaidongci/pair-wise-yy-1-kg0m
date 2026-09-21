"use strict";

// 服务引导：HTTP 入口在 lib/entry.js，判定规则在 lib/rules.js，档案存储在 lib/archive.js

const { server } = require("./lib/entry");

const PORT = Number(process.env.PORT || 3021);

server.listen(PORT, () => {
  console.log(`Watch case pressure inspection & delivery API running at http://127.0.0.1:${PORT}`);
});
