Cloudflare Worker 站点监测项目使用步骤

一、准备
1. 代码文件：worker.js
2. 必需绑定：KV 命名空间，变量名必须是 STATUS
3. 建议环境变量（可选）：
   - LOGIN_PASSWORD：登录密码（强烈建议修改默认值）
   - MONITOR_NAME：页面标题
   - GITHUB_URL：顶部 GitHub 按钮链接
   - BLOG_URL：顶部 Blog 按钮链接（留空则不显示）
   - REFRESH_INTERVAL_MS：前端刷新间隔（毫秒，建议 60000~300000）

二、部署（Cloudflare Dashboard 方式）
1. 进入 Cloudflare -> Workers & Pages -> 创建/打开你的 Worker。
2. 把 worker.js 全部内容粘贴到编辑器并保存。
3. 在 Settings -> Variables 中添加上面的环境变量（至少改 LOGIN_PASSWORD）。
4. 在 Settings -> Bindings -> KV Namespace 里添加绑定：
   - Variable name: STATUS
   - KV namespace: 选择你创建的 KV
5. 点击 Deploy 部署。

三、部署（Wrangler 命令行方式，可选）
1. 安装并登录：
   - npm i -g wrangler
   - wrangler login
2. 在项目目录创建 wrangler.toml（示例）：
   name = "site-monitor"
   main = "worker.js"
   compatibility_date = "2026-02-21"

   [[kv_namespaces]]
   binding = "STATUS"
   id = "你的KV命名空间ID"
3. 部署：
   - wrangler deploy

四、首次使用
1. 打开 Worker 域名。
2. 输入 LOGIN_PASSWORD 登录。
3. 系统会在 KV 为空时自动写入默认站点列表。

五、功能说明
1. 查看状态：
   - 页面会调用 /api/status 检测站点可达性。
   - 每个站点保留最近 30 次历史记录，并显示可用率百分比。
2. 添加站点：
   - 点击“管理”展开面板，输入名称和 URL（仅支持 http/https）。
   - 点击“添加”后会写入 KV。
3. 删除站点：
   - 点击站点右侧垃圾桶按钮，确认后删除。
4. 退出登录：
   - 点击页面顶部“[退出]”。

六、数据存储说明
1. 站点列表键：config_list_v1
2. 状态历史键：status_history_v1
3. 两者都存放在 STATUS KV 中。

七、常见问题排查
1. 打开页面直接 401：
   - 检查是否已登录，或 cookie 是否被浏览器禁用。
2. 添加/删除失败：
   - 检查 STATUS 绑定是否存在、KV 权限是否正常。
3. 大量站点显示离线：
   - 目标站点可能屏蔽探测请求，或网络波动；
   - 当前策略为 HEAD 失败后回退 GET，已尽量降低误报。
4. 页面样式异常：
   - 确认 /style.css 与 /script.js 路由可访问（由 worker.js 内联返回）。

八、安全建议
1. 立即修改默认登录密码。
2. 不要把真实密码写进公开仓库。
3. 可考虑只允许自己常用 IP 访问（如需可再加白名单逻辑）。
