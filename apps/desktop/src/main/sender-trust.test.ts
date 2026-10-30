/**
 * 可信发送者判定（替代 4.5 `check-renderer-file-urls.cjs` 的 URL 白名单方案）。
 *
 * 4.5 靠「渲染页 URL 与入口文件是否等价」来判断请求是否可信，需要处理 `~`/`%7E` 等
 * 编码等价、Windows 盘符、查询串等一堆边角。新架构改成**对象身份比较**：
 * 发送者必须是主窗口的 webContents、且发送 frame 必须是它的顶层 frame。
 * 身份无法被伪造，因此不再需要 URL 归一化；这里用用例把这两条钉住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf8');

describe('可信发送者判定', () => {
  it('同时比较 webContents 与顶层 frame 身份', () => {
    expect(source).toContain('isTrustedSender');
    expect(source).toMatch(/candidate\.sender === mainWindow\.webContents/);
    expect(source).toMatch(/candidate\.senderFrame === mainWindow\.webContents\.mainFrame/);
  });

  it('窗口不存在或已销毁时一律判为不可信', () => {
    expect(source).toMatch(/if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) return false/);
  });

  it('渲染页只从固定路径加载，不接受外部传入的页面地址', () => {
    expect(source).toMatch(/loadFile\(path\.join\(__dirname, '\.\.\/renderer\/index\.html'\)\)/);
    expect(source).not.toMatch(/loadURL\(payload/);
  });

  it('IPC 注册层在业务之前先做信任校验', () => {
    const ipc = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/main/ipc.ts'), 'utf8');
    expect(ipc).toMatch(/if \(!isTrustedSender\(event\)\) return ipcFail\('UNTRUSTED_SENDER'/);
  });
});
