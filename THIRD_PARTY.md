# 来源与第三方说明

本项目参照 FreePP 的公开源码研究项目形式发布，保留来源、作者说明及本地修改记录，不额外声明整包采用 MIT、Apache-2.0 等统一许可证。已有组件的许可证与版权声明继续适用；研究用途说明不替代这些条款。

## 源码来源

| 范围 | 来源与用途 |
| --- | --- |
| `src/`、`public/`、`tools/`、数据库迁移 | 从维护者现有注册平台整理，包含本地调度、管理界面、自动邮箱、批量注册及恢复流程。 |
| `vendor/freepp/` | 基于 [mio-cc/freepp](https://github.com/mio-cc/freepp) 的注册后端。参考提交为 `6a5f1d606a02844e4d643e18ecbceb1e513da58d`；本地文件包含额外修改，并非该提交的原样副本。 |
| `python/rebind_worker/` | 从维护者现有 [mail-split-gateway](https://github.com/foreverninght/mail-split-gateway) 服务抽取的 Python 后处理模块，承担会话恢复、MFA 与资格检测，不是另一套注册实现。模块本身与其中引用的代码、SDK 分别记录来源。 |
| Sentinel 实现与脚本资源 | 保留文件头对官方 SDK、重建/反编译实现及参考算法的来源说明；共享 worker 内的 SDK 资源用于其运行依赖。 |

注册后端仍只有 FreePP；历史 HAR 后端未纳入交付。主要本地修改包括队列与租约隔离、私有凭据持久化、后处理恢复、标准输入IPC、日志脱敏与本地请求边界，详见 `SOURCE_SNAPSHOT.json` 和 Git 提交记录。

## 上游说明

FreePP 的 [README](https://github.com/mio-cc/freepp/blob/6a5f1d606a02844e4d643e18ecbceb1e513da58d/README.md) 将其定位为自动化研究项目，并写明“仅供学习研究，请遵守目标平台服务条款与当地法律”。本项目沿用这种用途说明。

上游 [sentinel_pure_vm.py](https://github.com/mio-cc/freepp/blob/6a5f1d606a02844e4d643e18ecbceb1e513da58d/backend/reg/sentinel_pure_vm.py) 标注基于官方 sdk.js@20260219f9f6 反编译，并提及 codebai.cn 与 realasfngl 的算法及指令表参考。[sentinel_assets](https://github.com/mio-cc/freepp/tree/6a5f1d606a02844e4d643e18ecbceb1e513da58d/backend/ba_paypal/sentinel_assets) 包含 SDK、bootstrap 和 bridge；其 npm 清单的 private:true 是 npm 发布设置，不是许可证。

本次读取到的上游 README 未包含整包许可证，根 LICENSE 请求返回404，因此这里不将其标为 MIT。公开可读和明确授予再分发许可是不同事项；本说明如实记录已核实内容，不替上游授予许可。

共享 worker 的 `registration_core/auth_flow.py` 引用 zc-zhangchen/any-auto-register，并在原注释中称其为 MIT；该引用的对应版本和许可正文尚未独立核实。捆绑资源 `sdk_20260810913b.js` 的 SHA-256 为 `97bc85bf6072d10329ff68c373aac488984450f8fe971f58265953a74eeb71c3`，用于标识文件，不作为许可证明。

## 外部依赖

| 直接 Node 依赖 | 锁定版本 | 许可证 |
| --- | --- | --- |
| pg | 8.23.0 | MIT |
| playwright-core | 1.62.1 | Apache-2.0，并附 Microsoft/Puppeteer 来源 NOTICE |
| stream-json | 3.7.0 | BSD-3-Clause |
| undici | 6.28.1 | MIT |

Node 锁文件有18个非根条目，均含精确版本、下载地址与 integrity；许可字段统计为 MIT 13、ISC 2、Apache-2.0 1、BSD-3-Clause 2。下载来源为 npmmirror 15项、npmjs 3项。此统计不代替包内捆绑组件及 NOTICE。

Camoufox、CloakBrowser 和其 UAParser 依赖链不在当前安装集合中。源码包不捆绑 node_modules、虚拟环境或浏览器二进制。

Python 安装入口为根 requirements.txt；直接依赖采用固定版本与兼容范围的组合，传递依赖和制品哈希尚未完整锁定。各依赖自己的版权与许可证仍适用。

`SOURCE_SNAPSHOT.json` 记录历史输入与本地修改，`SHA256SUMS` 记录交付文件校验值。源码包排除生产配置、账号数据、日志和其它运行产物。
