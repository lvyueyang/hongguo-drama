import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          // 媒体链用例会起真子进程（ffmpeg 替身、worker_threads）并做真实 IO，
          // 默认 5s 在满负荷并行时会误报超时（实测 62 个 worker 同时跑时偶发）。
          testTimeout: 20_000,
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/desktop/src/main/**/*.test.ts',
            'apps/desktop/src/preload/**/*.test.ts',
          ],
        },
      },
      {
        // React 19 的 act 只在开发构建里导出；jsdom 项目必须显式声明 test 环境，
        // 否则 @testing-library/react 会拿到 react-dom 的生产构建并报 React.act is not a function。
        define: { 'process.env.NODE_ENV': JSON.stringify('test') },
        resolve: { conditions: ['development', 'browser', 'import', 'default'] },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['apps/desktop/src/renderer/**/*.test.ts', 'apps/desktop/src/renderer/**/*.test.tsx'],
        },
      },
    ],
  },
});
