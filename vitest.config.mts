import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
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
