# codingplan-usage

查询 AI Coding Plan（编码套餐）的额度与用量：月度额度还剩多少、限流窗口用了多少、本周期花费 / 调用数 / token 数。

多 provider 设计；当前已支持 **Command Code**，更多 provider 欢迎提 issue 或 PR。

单文件 Node 脚本，零依赖，只读查询（不消耗额度、不产生费用）。

## 支持的 Provider

| Provider | 状态 | 说明 |
| --- | :-: | --- |
| Command Code | ✅ 已支持 | 下文「密钥配置 / 用法 / 输出读法」均以此为例 |
| 更多 Coding Plan provider | 🙋 欢迎 PR | 提 issue 附上额度查询端点即可低成本接入 |

## 平台支持

| 平台 | 支持 | 说明 |
| --- | :-: | --- |
| macOS | ✅ 已验证 | 作者日常使用环境，长期实际运行 |
| Windows | 🟡 预期支持 | 纯 Node 实现、无平台专属 API，理论上直接可跑；**未实测** |
| Linux | 🟡 预期支持 | 同上，**未实测** |

要求 **Node ≥ 18**（用到全局 `fetch` 与 `AbortSignal.timeout`）。Windows / Linux 上如遇问题欢迎提 issue。

## 密钥配置（Command Code）

脚本按以下顺序自动找 Command Code 的 API key，找到即停：

1. 环境变量 `CMD_API_KEY`（推荐，通用方式）：
   ```bash
   export CMD_API_KEY=你的_commandcode_api_key
   ```
2. `~/.zcode/v2/provider_config.json` 里 `providerId === "commandcode"` 路由的 `apiKey`（ZCode 用户免配置，直接复用已配好的 key）。

不会把 key 打印到输出里；`--json` 模式也只输出密钥**来源**，不输出密钥本身。

## 用法（Command Code）

```bash
node quota.mjs          # 人读的摘要
node quota.mjs --json   # 结构化输出，供程序 / 判断使用
node quota.mjs --help
```

输出示例（数字为示意）：

```
Command Code — Pro · $41.44 left
账单周期  2026-09-20 → 2026-10-20
月度额度  ████████░░░░░░░░  48.2%  用掉 $38.56 / $80.00（剩 $41.44）
5 小时      ░░░░░░░░░░░░░░░░   1.5%  0.20 / 14.00 · 20:27 重置
本周        ███░░░░░░░░░░░░░  17.7%  6.19 / 35.00 · 10-18 00:00 重置
本周期累计 $38.53 · 8,412 次调用 · 1.87B tok（入 1.86B / 出 10.6M）
成功率    100%
密钥来源  $CMD_API_KEY
```

## 输出读法（Command Code）

- **月度额度**是真正的计费池，判断「还够不够」看这行。
- **5 小时 / 本周**是限流窗口，不是钱；撞到上限表现为请求 429/403，等 `重置` 即可，不代表额度用完。
- 月度上限来自套餐表（Go 10 / GOAT 70 / Pro 80 / Max 300）；API 自身只报「还剩」，套餐未知时会显示 `上限未知`，此时不要硬按百分比理解。
- 这是**账户级**总额度，不是单次会话或单个项目的消耗。

## 已知限制（Command Code）

- 数据源 `/alpha/*` 是未公开路由，上游改名会 404；届时改 `quota.mjs` 顶部的 `BASE` 与三个 `*_PATH` 常量即可。
- dashboard 用的 `/internal/*` 只认浏览器 session cookie，API key 会 401，本工具不走这条路。

## License

[MIT](./LICENSE)
