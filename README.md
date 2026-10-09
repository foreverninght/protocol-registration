# 协议注册工作台

用于批量管理 ChatGPT 协议注册的 Web 工作台。通过浏览器配置邮箱、代理和并发任务，自动完成验证码轮询、注册流程及可选的密码、2FA 和会话处理，并将账号资料保存到 PostgreSQL。注册后端基于 [FreePP](https://github.com/mio-cc/freepp)。

## 主要功能

- **批量注册**：导入邮箱候选或生成邮箱，使用并发队列执行任务，查看进度、失败原因和重试状态。
- **自动收码**：支持 Cloudflare 临时邮箱、mail.com 主邮箱及别名，以及分享页、iCloud 和公开邮箱接口渠道。
- **代理池**：管理注册代理与独立资格检测代理，支持导入、切换、可用性检查和冷却。
- **注册附加步骤**：按需启用密码设置、TOTP 两步验证、OAuth/session 验证、邮箱换绑和资格复核。
- **账号管理**：保存密码、2FA 密钥、令牌与会话，支持凭据修复、状态检查和批量复制。
- **任务持久化**：任务、事件和账号写入数据库，支持重启后的状态管理与过期任务租约恢复。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| Node.js | 22.9 或更高版本 |
| Python | 3.11 或更高版本 |
| PostgreSQL | 17 或更高版本 |
| Docker Compose | 可选；使用附带配置启动数据库时需要 Compose v2 |

需要自行准备可用的邮箱渠道；邮箱接口、域名、认证信息和代理均在本地配置。协议注册无需下载浏览器。

## 安装与启动

### 1. 获取项目并安装 Node 依赖

```sh
git clone https://github.com/foreverninght/protocol-registration.git
cd protocol-registration
npm ci --ignore-scripts
```

### 2. 创建 Python 环境

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Linux / macOS：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

### 3. 初始化配置并启动

```sh
npm run setup
docker compose up -d --wait db
npm run migrate
npm start
```

打开 **http://127.0.0.1:3200**。

`npm run setup` 自动创建 `.env`，生成随机数据库密码并设置本项目的 Python 路径；重复执行会保留已有配置。Compose 只启动数据库，应用由 `npm start` 启动。

已有 PostgreSQL 的使用者，可在 `.env` 中设置 `SIGNLIST_DATABASE_URL`，跳过 Docker 命令，再执行迁移和启动命令。迁移可重复执行。

## 首次使用

界面分为 **运行、邮箱、代理池** 三个页面。

### 配置邮箱

在“邮箱”页配置所用渠道：

- **Cloudflare 临时邮箱**：填写邮箱服务 API 地址、认证信息和可用域名。
- **mail.com**：导入主邮箱并管理别名；批量导入格式为每行 `邮箱----邮箱密码`。
- **邮箱候选**：每行填写一个邮箱，或按页面格式提供邮箱及取件链接。

邮箱服务需要能够接收并读取验证码。配置完成后，由工作台自动轮询取码。

### 配置代理

在“代理池”页创建并选择注册代理池，然后导入代理。支持 `主机:端口` 和 HTTP(S) 代理 URL；带认证的格式为 `http://<用户名>:<密码>@<主机>:<端口>`。

启用资格复核时，另配置并选择“资格代理池”。代理账号和密码使用你自己的配置，不要填入源码或公开文档。

### 启动任务

1. 在“运行”页设置并发数量。
2. 按需开启密码、2FA、会话验证等附加步骤；启用邮箱换绑时，填写新邮箱服务地址、认证信息和域名。
3. 导入候选邮箱，或使用邮箱生成入口准备任务。
4. 启动自动注册，查看任务进度和失败详情。
5. 在账号列表选择账号，复制或批量导出凭据。

“停止自动注册”停止继续自动生成任务，已有排队和执行中的任务仍会按队列处理。

## 账号数据与导出

完整凭据复制格式为：

```text
email----password----2fa
```

该格式需要账号具备密码与2FA信息。令牌、cookies 和会话上下文保存在数据库中，不包含在上述文本格式内。需要完整迁移或备份时，应备份 PostgreSQL 数据库及本地配置。

`.env`、数据库和运行目录可能包含账号与代理凭据，使用时应限制访问，不要提交到公开仓库。

## 常用配置

| 配置项 | 用途 |
| --- | --- |
| `HOST` | 应用监听地址，默认 `127.0.0.1` |
| `PORT` | 应用端口，默认 `3200` |
| `SIGNLIST_DATABASE_URL` | PostgreSQL 连接地址 |
| `FREEPP_PYTHON` | 协议工作器使用的 Python 解释器；setup 自动配置 |
| `SIGNLIST_ALLOWED_ORIGINS` | 反向代理部署时允许的浏览器来源，多个来源用逗号分隔 |

数据库 Compose 默认映射到本机 `54329` 端口。邮箱、代理和注册附加步骤优先通过界面配置。

工作台面向可信操作者，没有内建多用户登录。远程使用可通过 SSH 端口转发；使用反向代理对外提供访问时，应配置身份认证、TLS 和来源白名单。

## 开发与测试

```sh
npm run check
npm test
npm run test:python
npm run test:worker
```

Python 测试命令优先使用项目 `.venv`。数据库测试需要 `SIGNLIST_TEST_DATABASE_URL` 指向独立的本机测试库，并允许测试角色创建、删除临时数据库；未设置时会跳过数据库相关测试。

## 项目来源

感谢 [mio-cc/freepp](https://github.com/mio-cc/freepp) 的协议实现。第三方来源、依赖及相关条款见 [THIRD_PARTY.md](THIRD_PARTY.md)。

本项目用于学习研究，使用者应遵守所接入平台的服务条款及适用法律。
