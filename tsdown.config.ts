import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-connect-trae-models'

/**
 * 客户端（浏览器）侧必须外部化的包：宿主通过 window.__ModuleLoader__ 在运行时
 * 提供这些模块，客户端 bundle 绝不能把它们打进产物 —— loader 会用宿主自己的
 * 模块注册表来 require 它们。
 *
 * 注意 react-dom 必须外部化：它是宿主 shell 模块加载器（staticModules）注册的，
 * 外部化后 import 会变成浏览器可解析的 require。若把 react-dom 打进 bundle，
 * 会内联它的 CJS 构建，其开头是
 *   if (process.env.NODE_ENV !== "production") …
 * 在浏览器模块求值阶段就会抛出 `ReferenceError: process is not defined`，
 * 导致整个客户端半区加载失败。
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

export default defineConfig([
  {
    // 宿主入口：唯一发布类型声明的一半（package.json 的 types 指向
    // lib/index.d.ts）。浏览器半区由宿主 loader 消费，不产出类型。
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    outExtensions: () => ({ js: '.js' }),
    clean: true,
    sourcemap: false,
  },
  {
    // 浏览器半区：产出 lib/client.js（CJS bundle），用 window.__ModuleLoader__
    // 自注册。platform: 'browser' 贴合宿主注入场景，与 dsh-connect-trae 一致。
    entry: ['src/client/index.tsx'],
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    sourcemap: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
