/**
 * 选集面板（迁移自 4.5 `src/native/episode-panel.test.cjs`）。
 *
 * 面板靠「加宽主窗口」实现，所以真正要守的是**窗口几何的不变量**：
 * 重复打开不能叠加加宽、关闭必须还原到打开前的宽度与位置、用户拖过窗口后
 * 关闭也只能收回面板那一份、工作区变窄时加宽要收在屏幕内、切横屏不给开、
 * 只有可信主窗口能改窗口状态。
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createEpisodePanelController } from './episode-panel.ts';

const area = { x: 0, y: 0, width: 1440, height: 900 };

interface Handlers {
  [channel: string]: (event: unknown, value?: unknown) => unknown;
}

function fixture({ layout = 'portrait' as 'portrait' | 'landscape', width = 620 } = {}) {
  const main: any = new EventEmitter();
  main.webContents = Object.assign(new EventEmitter(), { mainFrame: {} });
  main.isDestroyed = () => false;
  let bounds: any = { x: 200, y: 30, width, height: 850 };
  let top = false;
  let workArea = { ...area };
  main.getBounds = () => ({ ...bounds });
  main.setBounds = (value: any) => {
    bounds = value;
  };
  main.getMinimumSize = () => [420, 560];
  main.setAlwaysOnTop = (value: boolean) => {
    top = value;
  };
  main.isAlwaysOnTop = () => top;

  const handlers: Handlers = {};
  const ipcMain = {
    handle: (name: string, fn: (event: unknown, value?: unknown) => unknown) => {
      handlers[name] = fn;
    },
    on() {},
  };
  let currentLayout: string = layout;
  const controller = createEpisodePanelController({
    ipcMain,
    screen: { getDisplayMatching: () => ({ workArea }) },
    getMainWindow: () => main,
    getLayout: () => currentLayout,
  } as any);
  controller.attach(main);

  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  return {
    main,
    handlers,
    event,
    controller,
    toggle: (value: unknown) => handlers['set-episode-panel-open'](event, value),
    alwaysOnTop: (value: unknown) => handlers['set-always-on-top'](event, value),
    bounds: () => ({ ...bounds }),
    setWorkArea: (next: { x: number; y: number; width: number; height: number }) => {
      workArea = next;
    },
    setLayout: (next: 'portrait' | 'landscape') => {
      currentLayout = next;
    },
  };
}

describe('选集面板：加宽与还原', () => {
  it('打开时只加宽面板那一份，重复打开不叠加', () => {
    const f = fixture();
    expect(f.toggle(true)).toBe(200);
    expect(f.bounds()).toEqual({ x: 200, y: 30, width: 820, height: 850 });
    expect(f.toggle(true)).toBe(200);
    expect(f.bounds().width).toBe(820);
  });

  it('关闭还原到打开前的宽度与位置', () => {
    const f = fixture();
    f.toggle(true);
    expect(f.toggle(false)).toBe(0);
    expect(f.bounds()).toEqual({ x: 200, y: 30, width: 620, height: 850 });
  });

  it('窗口贴着屏幕右缘时打开会把窗口左移到屏幕内，关闭回到原位', () => {
    const f = fixture();
    f.main.setBounds({ x: 820, y: 30, width: 620, height: 850 });
    f.toggle(true);
    expect(f.bounds()).toEqual({ x: 620, y: 30, width: 820, height: 850 });
    f.toggle(false);
    expect(f.bounds().x).toBe(820);
  });

  it('面板打开期间用户手动加宽过窗口，关闭后保留用户那一份', () => {
    const f = fixture();
    f.toggle(true);
    f.main.setBounds({ ...f.bounds(), width: f.bounds().width + 50 });
    f.toggle(false);
    expect(f.bounds().width).toBe(670);
  });

  it('工作区比默认加宽窄时，加宽收在工作区内并可还原', () => {
    const f = fixture();
    f.setWorkArea({ x: 0, y: 0, width: 700, height: 900 });
    f.main.setBounds({ x: 0, y: 30, width: 620, height: 850 });
    expect(f.toggle(true)).toBe(80);
    expect(f.bounds().width).toBe(700);
  });

  it('页面开始加载（如换集刷新）就自动收面板', () => {
    const f = fixture();
    f.toggle(true);
    f.main.webContents.emit('did-start-loading');
    expect(f.bounds().width).toBe(620);
  });

  it('窗口关闭时清掉面板状态，之后关闭是空操作', () => {
    const f = fixture();
    f.toggle(true);
    f.main.emit('close');
    expect(f.bounds().width).toBe(620);
    expect(f.controller.close()).toBe(0);
  });
});

describe('选集面板：权限与布局', () => {
  it('非可信发送者不能改窗口状态', () => {
    const f = fixture();
    for (const channel of ['set-episode-panel-open', 'set-always-on-top']) {
      expect(() => f.handlers[channel]({ sender: {}, senderFrame: {} }, true)).toThrow();
    }
  });

  it('状态值必须是布尔，字符串一律拒绝', () => {
    const f = fixture();
    expect(() => f.toggle('yes')).toThrow();
    expect(() => f.alwaysOnTop('yes')).toThrow();
    expect(f.bounds().width).toBe(620);
  });

  it('横屏模式不给开选集', () => {
    const f = fixture({ layout: 'landscape' });
    expect(() => f.toggle(true)).toThrow();
    expect(f.bounds().width).toBe(620);
  });

  it('置顶开关回读真实状态', () => {
    const f = fixture();
    expect(f.alwaysOnTop(true)).toBe(true);
    expect(f.handlers['get-always-on-top'](f.event)).toBe(true);
    expect(f.alwaysOnTop(false)).toBe(false);
    expect(f.handlers['get-always-on-top'](f.event)).toBe(false);
  });
});
