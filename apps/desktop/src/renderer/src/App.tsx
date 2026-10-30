import { Button, cn } from '@hongguo/ui';
import { useState } from 'react';
import Account from './pages/Account.tsx';
import Calendar from './pages/Calendar.tsx';
import Discover from './pages/Discover.tsx';
import DownloadManager from './pages/DownloadManager.tsx';
import FloatingPlayer from './pages/FloatingPlayer.tsx';
import History from './pages/History.tsx';
import Library from './pages/Library.tsx';
import Rankings from './pages/Rankings.tsx';
import Search from './pages/Search.tsx';
import Settings from './pages/Settings.tsx';

type PageId =
  | 'browse'
  | 'feed'
  | 'download'
  | 'player'
  | 'history'
  | 'calendar'
  | 'manager'
  | 'account'
  | 'settings';

interface PageDef {
  id: PageId;
  label: string;
  render(): React.ReactNode;
}

const PAGES: PageDef[] = [
  { id: 'browse', label: '发现短剧', render: () => <Discover /> },
  { id: 'feed', label: '热播推荐', render: () => <Rankings /> },
  { id: 'download', label: '搜索与下载', render: () => <Search /> },
  { id: 'player', label: '我的剧库', render: () => <Library /> },
  { id: 'history', label: '观看记录', render: () => <History /> },
  { id: 'calendar', label: '收藏与上新', render: () => <Calendar /> },
  { id: 'manager', label: '下载管理', render: () => <DownloadManager /> },
  { id: 'account', label: '红果账号', render: () => <Account /> },
  { id: 'settings', label: '设置', render: () => <Settings /> },
];

/**
 * 悬浮小窗走同一个渲染入口，用 query 切到独立布局：
 * 主界面（导航、全局快捷键、页面缓存）完全不挂载，避免小窗抢主窗口的键盘与查询。
 */
function readFloatingRequest(): { vid: string; seriesId: string } | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('floating') !== '1') return null;
  const vid = params.get('vid') ?? '';
  const seriesId = params.get('seriesId') ?? '';
  return vid && seriesId ? { vid, seriesId } : null;
}

export default function App() {
  const floatingRequest = readFloatingRequest();
  if (floatingRequest) {
    return <FloatingPlayer vid={floatingRequest.vid} seriesId={floatingRequest.seriesId} />;
  }
  return <MainWindow />;
}

function MainWindow() {
  const [page, setPage] = useState<PageId>('browse');
  const current = PAGES.find((entry) => entry.id === page) ?? PAGES[0];

  return (
    <div className="flex h-full bg-canvas">
      <aside className="sidebar-select-none flex w-[var(--sidebar-width)] flex-col border-r border-border-subtle bg-sidebar">
        <div className="app-drag flex h-[var(--toolbar-height)] items-end pb-2 mac-traffic-inset">
          <span className="text-[var(--font-size-label)] font-semibold">红果短剧</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2 pb-2">
          {PAGES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setPage(entry.id)}
              aria-current={page === entry.id ? 'page' : undefined}
              className={cn(
                'app-no-drag flex h-8 items-center rounded-[var(--radius-control)] px-2.5 text-left text-[var(--font-size-label)] transition-colors',
                page === entry.id
                  ? 'bg-selection font-medium text-primary-text'
                  : 'text-secondary-text hover:bg-selection/60',
              )}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="px-3 pb-3 text-[var(--font-size-caption)] text-muted">5.0.0 · dev</div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="app-drag flex h-[var(--toolbar-height)] items-center justify-between border-b border-border-subtle px-4">
          <h1 className="text-[var(--font-size-label)] font-semibold">{current.label}</h1>
          <div className="app-no-drag flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPage('download')}>
              搜索
            </Button>
          </div>
        </header>
        <section className="min-h-0 flex-1">{current.render()}</section>
      </main>
    </div>
  );
}
