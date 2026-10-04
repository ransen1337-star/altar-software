# Altar

![Altar Logo](public/altar-logo.png)

Altar 是 Windows 桌面端开发环境管理工具。项目只保留源码、配置和测试，不在仓库中提交任何 Node.js、JDK、Go、.NET 或其他运行环境安装包。

## IMPORTANT

- 本项目面向 Windows 10/11 x64，桌面端使用 Electron，渲染层使用 React、TypeScript 和 Vite。
- 仓库不包含运行环境归档。安装器只在用户发起安装时下载，并在写入前校验官方 SHA-256 或 SHA-512。
- 不要把安装包、`dist/`、`node_modules/`、本机日志或用户数据提交到 Git。大体积镜像应放在独立 GitHub 仓库并使用 Git LFS。
- 安装和卸载涉及 PATH、注册表、用户目录、系统目录和 UAC。请先阅读界面中的安装范围和路径提示。
- 镜像文件必须保留官方校验值，校验失败时禁止发布和安装。
- Windows 运行时状态位于 `%LOCALAPPDATA%\DevEnvManager`，这是为兼容已有安装保留的内部数据目录，不要将该目录复制进源码仓库。

## 功能

- 管理 Python、Node.js、JDK、Go、Rust、.NET SDK、C/C++、PHP、Ruby、Dart、R、Julia、Perl、Lua、Kotlin 和 Scala。
- 发现已有安装，支持版本并存、切换、更新、卸载和 PATH 管理。
- 安装任务支持暂停、恢复、取消、断点续传、分段下载和完整性校验。
- 下载日志支持错误、标准和详细级别。
- 支持官方源、地区备用源，以及可选的 GitHub 镜像仓库。

## 开发运行

```powershell
npm install
npm run dev
```

`npm run dev` 会启动 Vite 和 Electron 桌面窗口。只启动浏览器渲染层可使用：

```powershell
npm run dev:web
```

## 验证

```powershell
npm test
npm run build
```

## GitHub 镜像同步设计

镜像同步脚本以官方发布元数据为事实来源：

1. 重新抓取官方版本清单和校验值。
2. 读取镜像仓库的 `manifest.json`。
3. 对比版本、文件名和哈希，只处理新增或发生变化的归档。
4. 下载并校验完整文件。
5. 校验通过后才更新清单，可选自动提交并推送。

在 Windows 上对一个已经 clone 的镜像仓库执行：

```powershell
.\scripts\update-mirror.ps1 `
  -MirrorRepository D:\repos\dev-env-mirror `
  -Push
```

也可以直接运行：

```powershell
node scripts/update-mirror.mjs --mirror-dir D:\repos\dev-env-mirror --push
```

软件设置页填写镜像仓库的 raw 根地址，例如：

```text
https://raw.githubusercontent.com/OWNER/REPOSITORY/main
```

软件会优先读取 `mirror/manifest.json` 和对应归档，镜像不可用时才回退到清单中记录的官方地址。

独立镜像仓库的 GitHub Actions 模板位于同级 `../git-mirror/.github/workflows/`。镜像仓库设置 `SOURCE_REPOSITORY` 仓库变量；私有主仓库还需要 `SOURCE_REPOSITORY_TOKEN` Secret。

## 目录结构

```text
electron/       Electron 主进程、安装器、下载器和 Windows 平台层
src/            React 页面、组件、状态和样式
scripts/        开发启动、镜像同步和维护脚本
tests/          安装器、下载器和 Windows 平台测试
../git-mirror/  独立 Git 镜像仓库和 GitHub Actions 工作流
```

运行环境归档目录和构建输出已从工作区移除；镜像方案只保留为源码脚本、工作流和本文档。

## 许可证与致谢

本项目使用 GNU AGPL-3.0，详见 [LICENSE](LICENSE)。部分前端布局、暗色主题、控件和交互设计基于 Widdit 的 `now-playing-frontend` 固定版本改造；原项目署名和许可要求保留在此处，源码界面不再显示原项目品牌声明。

第三方依赖的许可和安全公告应以各自发布页为准。发布镜像前请确认归档来源、官方哈希、许可证和 Git LFS 配额。
