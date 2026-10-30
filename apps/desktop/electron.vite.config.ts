import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// 工作区包全部打包进 out/main，不留在 node_modules 里。
const workspaceExternals = ['@hongguo/shared', '@hongguo/contract', '@hongguo/host', '@hongguo/sdk'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceExternals })],
  },
  preload: {
    // 工作区包必须打进 bundle：沙箱 preload 无法在运行时解析 workspace 说明符。
    plugins: [externalizeDepsPlugin({ exclude: workspaceExternals })],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      minify: true,
      sourcemap: false,
    },
  },
});
