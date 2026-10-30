/**
 * 字号不随窗口尺寸缩放（迁移自 4.5 `scripts/check-window-layout.cjs` 的 CSS 部分）。
 *
 * 4.5 的窗口布局/字号缩放函数（`fitWindowBounds` / `getWindowScale` / `saveWindowZoom`）
 * 在 5.0 已不存在：窗口只有悬浮播放器一处自管尺寸（见 main/floating-window.ts），
 * 字号是设计令牌而不是用户缩放。因此这里只保留仍然成立的那条不变量：
 * **字号不许挂在视口单位或响应式断点上**，否则同一个界面在不同窗口尺寸下会变样。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const VIEWPORT_UNIT =
  /(?<![\w-])[\d.]+(?:svw|svh|lvw|lvh|dvw|dvh|svi|svb|lvi|lvb|dvi|dvb|vmin|vmax|vw|vh|cqw|cqh|cqi|cqb|cqmin|cqmax)(?![\w-])/;
const FONT_PROPERTY = /^(?:font|font-size)$/;
const FONT_TOKEN = /(?:^|-)font(?:-|$)/;

function cssFiles(): string[] {
  const roots = ['apps/desktop/src', 'packages'];
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist-types' || entry.name === 'out') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.css')) files.push(full);
    }
  };
  for (const root of roots) walk(path.join(ROOT, root));
  return files;
}

/** 取出所有 `@media (宽度/高度/方向…)` 区块的正文，用于检查响应式断点里的字号。 */
function responsiveBlocks(css: string): string[] {
  const blocks: string[] = [];
  for (const match of css.matchAll(/@media[^{]*/g)) {
    const params = match[0];
    if (!/(?:width|height|orientation|aspect-ratio)/.test(params)) continue;
    const open = (match.index ?? 0) + params.length;
    if (css[open] !== '{') continue;
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          blocks.push(css.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return blocks;
}

function fontDeclarations(css: string): Array<{ property: string; value: string }> {
  const declarations: Array<{ property: string; value: string }> = [];
  for (const match of css.matchAll(/([-a-z]+)\s*:\s*([^;{}]+)/gi)) {
    const property = match[1]!.toLowerCase();
    if (FONT_PROPERTY.test(property) || (property.startsWith('--') && FONT_TOKEN.test(property)))
      declarations.push({ property, value: match[2]!.trim() });
  }
  return declarations;
}

describe('CSS 字号不跟随视口', () => {
  it('存在样式表（找不到文件说明路径变了，这条不变量就会静默失效）', () => {
    expect(cssFiles().length).toBeGreaterThan(0);
  });

  it('font / font-size 不使用视口单位或容器单位', () => {
    for (const file of cssFiles()) {
      const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const { property, value } of fontDeclarations(css)) {
        expect(VIEWPORT_UNIT.test(value), `${path.relative(ROOT, file)}: ${property}: ${value}`).toBe(false);
      }
    }
  });

  it('响应式断点里不改字号（布局可以变，字号不变）', () => {
    for (const file of cssFiles()) {
      const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const block of responsiveBlocks(css)) {
        const offenders = fontDeclarations(block);
        expect(offenders, `${path.relative(ROOT, file)}: ${JSON.stringify(offenders)}`).toEqual([]);
      }
    }
  });
});
