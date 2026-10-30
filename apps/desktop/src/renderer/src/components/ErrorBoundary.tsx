/**
 * 渲染层错误边界（迁移自 4.5 `src/components/ErrorBoundary.jsx`）。
 *
 * 新架构里这条**曾经整个缺失**：任何一个页面组件抛错都会让窗口白屏，
 * 用户只能强杀应用。这里补回来，并维持 4.5 的两条约定：
 * - 文案是中文的、可操作的（告知重载与重启），**不带任何错误细节/堆栈**；
 * - 提示用 `role="alert"` 播报给辅助技术。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 注入重载实现便于测试；默认重新加载当前窗口 */
  onReload?(): void;
  /** 上报回调（例如写日志）；界面本身不显示错误细节 */
  onError?(error: Error, info: ErrorInfo): void;
}

export interface ErrorBoundaryState {
  failed: boolean;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-3 bg-[var(--color-surface)] px-6 text-center">
        <div role="alert">
          <h1 className="text-[var(--font-size-title)] font-semibold">界面出现异常</h1>
          <p className="mt-1 text-[var(--font-size-label)] text-secondary-text">
            请重新加载后继续使用。若仍出现此提示，请关闭并重新打开应用。
          </p>
        </div>
        <button
          type="button"
          className="rounded-[var(--radius-control)] border border-border-subtle bg-surface px-3 py-1.5 text-[var(--font-size-label)] hover:bg-selection"
          onClick={() => {
            if (this.props.onReload) this.props.onReload();
            else window.location.reload();
          }}
        >
          重新加载
        </button>
      </main>
    );
  }
}
