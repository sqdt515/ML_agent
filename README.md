# New AI

基于 Tauri 2 + Vue 3 的桌面宠物应用基础版本，复用自 AI 步步（AIbubu）项目。

## 技术栈

- **桌面框架**：Tauri 2
- **后端语言**：Rust
- **前端框架**：Vue 3
- **状态管理**：Pinia
- **构建工具**：Vite
- **官网站点**：Astro

## 前置条件

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 9+
- [Rust](https://www.rust-lang.org/)（stable 通道）
  - 安装后通过 `rustup default stable` 切换到 stable
  - Tauri 2 还需要各平台原生构建依赖，详见 [Tauri Prerequisites](https://tauri.app/start/prerequisites/)

## 启动命令

在项目根目录执行：

```bash
# 安装依赖
pnpm install

# 启动桌面应用（开发模式，包含 Tauri 后端）
pnpm tauri dev

# 仅启动前端 dev server
pnpm dev

# 启动官网开发服务器
pnpm dev:site
```

## Agent 功能

桌宠支持双击打开 Agent 聊天窗口，与 DeepSeek 等 OpenAI 兼容接口对话：

- **入口**：双击桌宠打开 Agent 窗口；标题栏提供 最小化 / 隐藏 / 退出 按钮；托盘菜单可打开设置。
- **配置**：在设置面板的 Agent 区填写 API Key、接口地址（默认 `https://api.deepseek.com`）、模型（`deepseek-chat` / `deepseek-reasoner`）、系统提示词、工具开关与上下文预算（默认 24K token，上限 60K）。
- **能力**：流式输出、工具调用（显示/隐藏桌宠、打开链接、系统信息、时间、便签）、会话持久化（localStorage 自动恢复）。
- **安全**：LLM 请求全部走后端 Rust 网关（绕过 CSP），API Key 只保存在本地配置文件（`app_config_dir/agent.json`），日志与前端不会打印明文。

## 项目结构

```
new_ai/
├── package.json              # 根 workspace 配置
├── pnpm-workspace.yaml       # pnpm workspace 定义
├── .gitignore
├── .prettierrc
├── README.md
└── packages/
    ├── app/                  # 桌面应用（Tauri + Vue 3）
    │   ├── package.json
    │   ├── vite.config.ts
    │   ├── tsconfig.json
    │   ├── index.html
    │   ├── src/              # 前端源码
    │   │   ├── main.ts
    │   │   ├── App.vue
    │   │   ├── vite-env.d.ts
    │   │   ├── types/        # 类型定义
    │   │   ├── stores/       # Pinia 状态（pet、settings）
    │   │   ├── composables/  # 组合式函数（交互、窗口、i18n）
    │   │   ├── i18n/         # 国际化文案（zh/en）
    │   │   ├── pet/          # 宠物渲染（PetRenderer + SpriteRenderer）
    │   │   ├── components/   # 通用组件（SettingsPanel）
    │   │   ├── styles/       # 主题样式
    │   │   └── utils/        # 工具函数（skin）
    │   ├── public/skins/     # 宠物皮肤资源（skin.json + skin.png）
    │   └── src-tauri/        # Rust 后端
    │       ├── Cargo.toml
    │       ├── build.rs
    │       ├── tauri.conf.json
    │       ├── capabilities/ # Tauri 权限配置
    │       ├── icons/
    │       └── src/          # Rust 源码（main、lib、tray）
    └── site/                 # 官网（Astro）
        ├── package.json
        ├── astro.config.mjs
        ├── tsconfig.json
        └── src/
            ├── layouts/Base.astro
            └── pages/index.astro
```

## 复用功能说明

本项目从 AI 步步（AIbubu）复用以下基础能力：

- **透明窗口**：通过 Tauri 配置 `transparent: true`、`decorations: false` 实现无边框透明窗口，配合 `alwaysOnTop` 与 `skipTaskbar` 让宠物悬浮于桌面。
- **系统托盘**：在 `src-tauri/src/tray.rs` 中实现托盘菜单，支持显示/隐藏宠物、退出等操作。
- **拖拽**：通过 `usePetInteraction` 组合式函数处理宠物在桌面上的拖拽移动。
- **精灵图渲染**：`PetRenderer` 与 `SpriteRenderer` 配合 `public/skins/<name>/skin.json` 解析精灵图帧并循环播放动画。
- **i18n**：`i18n/` 目录提供 zh/en 双语文案，通过 `useI18n` 组合式函数在组件中使用。
- **主题切换**：`styles/theme.css` 定义 CSS 变量，`SettingsPanel` 中可切换明暗主题。
