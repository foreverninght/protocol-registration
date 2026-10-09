# 协议注册工作台

从现有服务中整理出的完整协议注册工作流。保留管理界面、批量任务、自动收码、并发队列、代理池、重试、注册后处理和数据库凭据保存；不是手工验证码的单次演示脚本。

本项目用于协议交互、自动化工作流与本地部署的学习研究；使用者应遵守所接入平台的服务条款及适用法律。注册后端基于 [mio-cc/freepp](https://github.com/mio-cc/freepp)，保留上游来源说明；本项目另有本地调度、界面和恢复流程的修改。

本项目采用公开源码的研究项目形式，保留引用组件的来源与原有声明。项目未额外声明覆盖全部代码的统一许可证，来源和依赖说明见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 保留的能力

- 唯一注册实现为 `freepp`，默认使用；界面隐藏单一实现选择器。显式请求已移出的 HAR 实现或旧别名时，任务 API 返回 400，不自动替换。
- 批量候选导入、邮箱生成、任务队列、自适应并发、自动启动/停止、租约恢复、失败重试与凭据修复。
- Cloudflare 临时邮箱、mail.com 主邮箱/别名管理，以及原有分享页、iCloud、公开邮箱接口渠道的自动轮询取码。邮箱服务和凭据由使用者在本地配置，不附任何生产账号。
- 注册代理池与独立资格代理池的导入、分配、质量检查、冷却和重试。
- 原有注册附加步骤：密码、TOTP、OAuth/session 验证、邮箱换绑及可选资格复核、phone probe；按界面设置启用，不改成手工取码。
- PostgreSQL 保存任务、事件、邮箱、账号、密码/TOTP、tokens、cookies 和会话上下文。保留原有凭据复制、批量凭据导出、测活和维护入口。

默认固定为 `registration-only` 功能配置：独立支付、提炼、绑手机队列及浏览器注册入口不启动。暂时保留与注册存在导入、表结构或辅助函数耦合的源码，避免删依赖破坏注册；它们的独立协调器与业务API在此配置下不运行。

## 本地启动

需要 Node.js 22.9+、Python 3.11+、PostgreSQL 17+。可使用附带 Compose 启动本地独立数据库；不依赖原服务器、原 FreePP 目录或其他运行中的管理服务。

Windows PowerShell，在项目目录执行：

```powershell
npm ci --ignore-scripts
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm run setup
docker compose up -d db
npm run migrate
npm start
```

Linux/macOS 的 Python 安装两步替换为：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

打开 `http://127.0.0.1:3200`。`npm run setup` 生成仅供本地使用的随机数据库密码、连接配置和 `.venv` Python 路径；已有 `.env` 保持原样。数据库默认仅绑定 `127.0.0.1:54329`，应用默认仅绑定本机3200端口。

使用已有本地 PostgreSQL 时，在 `.env` 中配置 `SIGNLIST_DATABASE_URL`，略过 Compose。迁移命令按顺序执行15份源码迁移，记录校验值，可重复执行；只对该连接指定的数据库生效。

当前安装集合仅保留协议工作流所需的 Node 依赖；已移除禁用浏览器启动器的安装依赖。纯协议注册不需要下载浏览器，因此采用 `--ignore-scripts`。

这是可信本地操作者使用的工作台，没有内建多用户登录或权限隔离。远程使用可通过 SSH 转发本机端口；若自行配置反向代理，应在代理层启用身份认证和 TLS，并将浏览器访问来源写入 `SIGNLIST_ALLOWED_ORIGINS`，例如 `https://registration.example.test`。该配置是 Host/Origin 白名单，不是登录认证。默认不接受其他网站发起的跨源请求，也不信任任意 Host。

## 使用流程

1. 在邮箱设置中接入实际使用的邮箱渠道；mail.com 可导入主邮箱并管理别名，Cloudflare 渠道配置接口地址、认证与域名。
2. 在代理设置中导入注册代理；启用资格复核时另配置资格代理池。
3. 设置并发及注册附加步骤，导入候选或使用已有邮箱生成入口。
4. 启动队列，界面查看取码、重试、注册与后处理进度。任务和账号保存在数据库，可重启后继续管理。
5. 在账号界面复制或批量导出凭据。原导出格式为 `email----password----2fa`，并不等于所有令牌的数据库备份；完整保留 tokens/cookies/session 时应备份本地 PostgreSQL 数据库。

界面/API提供真实凭据读取，数据库和 `data/` 也可能包含敏感运行结果。源码归档采用白名单，不收录这些文件。页面示例采用保留测试域名；个人服务地址和新邮箱域名须由使用者自行配置，不带历史默认值。详细核查见 [隐私复核](docs/privacy-audit.md)。

## 验证

```sh
npm run check
npm test
npm run test:python
npm run test:worker
```

Python 验证命令优先使用项目 `.venv`，无需依赖当前终端是否激活虚拟环境。数据库测试读取 `SIGNLIST_TEST_DATABASE_URL`，应指向独立的本机空测试库；批量和租约隔离测试需要测试角色具备创建、删除临时数据库的权限。测试会写入并清理合成数据。没有该变量时，数据库相关测试跳过。协议依赖和工作器测试使用合成数据与替身；整理期间未发起真实账号注册，离线通过不表示线上注册成功率已验证。

本次实际功能与发布核验见 [功能审核](docs/functional-audit.md) 和 [开源前审核](docs/release-audit.md)。`docs/registration-validation-standard.md` 保留原注册流程验收标准；源文件与交付文件指纹见 `SOURCE_SNAPSHOT.json` 和 `SHA256SUMS`。

## 项目边界

- `src/`、`public/`：完整注册调度、邮箱、代理、账号与管理界面。
- `db/migrations/`：完整兼容表结构，包含被共享引用的扩展表，不导入生产数据。
- `tools/`：协议桥、注册后处理、本地初始化和数据库迁移工具。
- `vendor/freepp/backend/`：唯一包内协议注册后端。
- `python/rebind_worker/`：资格和会话处理的共享源码依赖，不启动另一个管理服务。

历史 HAR 后端已移出运行目录和交付包；`SOURCE_SNAPSHOT.json` 中原始输入档哈希仅用于追溯来源。共享资格 worker 的解释器优先读取 `SIGNLIST_TRIAL_WORKER_PYTHON`、`FREEPP_PYTHON`，最后兼容旧 `FREEPP_HAR_PYTHON`；兼容变量不注册第二套实现。

使用 `python tools/build-release.py --output ../protocol-registration-source.zip` 按源码白名单生成候选归档；已有目标文件不会被覆盖。归档排除 `.env`、数据库、账号、日志、HAR、缓存、依赖安装目录和虚拟环境。

所有抽离和修改发生在此本地项目。未回写源服务器应用、配置或数据库，也未覆盖已有 FreePP 工作目录。
