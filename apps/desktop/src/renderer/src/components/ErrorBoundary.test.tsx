/**
 * 错误边界（迁移自 4.5 `scripts/check-error-boundary.cjs`）。
 *
 * 守四条：正常子组件不受影响；真实子组件抛错时显示中文恢复提示；
 * 提示用 role="alert" 且**不含错误细节**；点「重新加载」能恢复。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from './ErrorBoundary.tsx';

afterEach(() => cleanup());

function Boom({ crash }: { crash: boolean }) {
  if (crash) throw new Error('PRIVATE_STACK_SENTINEL');
  return <p>正常界面</p>;
}

describe('错误边界', () => {
  it('子组件正常时原样渲染，不显示恢复界面', () => {
    render(
      <ErrorBoundary>
        <Boom crash={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('正常界面')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('子组件抛错时显示中文恢复提示，并播报给辅助技术', () => {
    // React 会把捕获到的错误打到 console.error，这里静音避免污染测试输出
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom crash />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/界面出现异常/);
    expect(alert.textContent).toMatch(/重新加载后继续使用/);
    silence.mockRestore();
  });

  it('界面里不出现错误细节或堆栈', () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary>
        <Boom crash />
      </ErrorBoundary>,
    );
    expect(container.textContent ?? '').not.toContain('PRIVATE_STACK_SENTINEL');
    silence.mockRestore();
  });

  it('重载按钮触发注入的恢复动作', () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReload = vi.fn();
    render(
      <ErrorBoundary onReload={onReload}>
        <Boom crash />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText('重新加载'));
    expect(onReload).toHaveBeenCalledTimes(1);
    silence.mockRestore();
  });

  it('错误上报给调用方，但不进入界面', () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Boom crash />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const captured = onError.mock.calls[0] as [Error] | undefined;
    expect(captured?.[0].message).toBe('PRIVATE_STACK_SENTINEL');
    silence.mockRestore();
  });
});
