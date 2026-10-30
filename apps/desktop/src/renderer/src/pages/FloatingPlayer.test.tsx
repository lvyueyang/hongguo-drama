/**
 * 悬浮小窗的独立布局（`?floating=1`）。
 *
 * 守两条：小窗只取地址、播放、上报进度，不挂主界面；进度上报要节流，
 * 暂停/播完必须立刻写（否则用户关窗会丢最后一段）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FloatingPlayer from './FloatingPlayer.tsx';

afterEach(() => cleanup());

describe('悬浮小窗', () => {
  it('取到地址后播放，标题栏提示小窗状态', async () => {
    const load = vi.fn(async () => ({ url: 'hongguo-stream://ep/11' }));
    render(<FloatingPlayer vid="11" seriesId="123" load={load} />);
    await waitFor(() => expect(screen.getByLabelText('悬浮小窗播放')).toBeTruthy());
    expect(load).toHaveBeenCalledWith('11', '123');
    expect(screen.getByText(/小窗播放中/)).toBeTruthy();
  });

  it('来源未开放时给出错误文案，不渲染播放器', async () => {
    const load = vi.fn(async () => ({ error: '该集已锁定' }));
    render(<FloatingPlayer vid="11" seriesId="123" load={load} />);
    await waitFor(() => expect(screen.getByText('该集已锁定')).toBeTruthy());
    expect(screen.queryByLabelText('悬浮小窗播放')).toBeNull();
  });

  it('取地址失败也不崩，显示原因', async () => {
    const load = vi.fn(async () => {
      throw new Error('网络不可用');
    });
    render(<FloatingPlayer vid="11" seriesId="123" load={load} />);
    await waitFor(() => expect(screen.getByText('网络不可用')).toBeTruthy());
  });

  it('暂停时立即写进度，且带上剧集与时长', async () => {
    const save = vi.fn(async () => ({}));
    const load = vi.fn(async () => ({ url: 'hongguo-stream://ep/11' }));
    render(<FloatingPlayer vid="11" seriesId="123" load={load} save={save} />);
    const video = (await screen.findByLabelText('悬浮小窗播放')) as HTMLVideoElement;

    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'duration', { value: 100, configurable: true });
    fireEvent.pause(video);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      seriesId: '123',
      vid: '11',
      vidIndex: 1,
      currentTime: 42,
      duration: 100,
      watched: true,
    });
  });

  it('播放中（timeupdate）节流：连续事件不会每次都写', async () => {
    const save = vi.fn(async () => ({}));
    render(<FloatingPlayer vid="11" seriesId="123" load={async () => ({ url: 'x' })} save={save} />);
    const video = (await screen.findByLabelText('悬浮小窗播放')) as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { value: 5, configurable: true });
    Object.defineProperty(video, 'duration', { value: 100, configurable: true });
    for (let index = 0; index < 5; index++) fireEvent.timeUpdate(video);
    // 5 秒内只写第一次
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });
});

describe('小窗的集号、续播与连播（4.5 的悬浮宿主语义）', () => {
  const episodes = [
    { vid: 'v1', vid_index: 1 },
    { vid: 'v2', vid_index: 2 },
    { vid: 'v3', vid_index: 3, locked: true },
  ];

  it('按真实集号上报进度（不再写死第 1 集）', async () => {
    const save = vi.fn(async () => ({}));
    render(
      <FloatingPlayer
        vid="v2"
        seriesId="123"
        load={async () => ({ url: 'hongguo-stream://ep/v2' })}
        save={save}
        loadEpisodes={async () => episodes}
      />,
    );
    const video = (await screen.findByLabelText('悬浮小窗播放')) as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { value: 12, configurable: true });
    Object.defineProperty(video, 'duration', { value: 100, configurable: true });
    fireEvent.pause(video);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ vid: 'v2', vidIndex: 2, currentTime: 12, watched: true }),
    );
    expect(screen.getByText(/第 2 集/)).toBeTruthy();
  });

  it('同一集有进度时续播到上次位置', async () => {
    render(
      <FloatingPlayer
        vid="v2"
        seriesId="123"
        load={async () => ({ url: 'hongguo-stream://ep/v2' })}
        loadEpisodes={async () => episodes}
        readProgress={async () => ({ vid: 'v2', currentTime: 48 })}
      />,
    );
    const video = (await screen.findByLabelText('悬浮小窗播放')) as HTMLVideoElement;
    let seeked = 0;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => seeked,
      set: (value: number) => {
        seeked = value;
      },
    });
    await waitFor(() => expect(seeked).toBe(0));
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(seeked).toBe(48));
  });

  it('播完自动接下一集；锁定的下一集不自动播', async () => {
    const load = vi.fn(async (target: string) => ({ url: `hongguo-stream://ep/${target}` }));
    render(
      <FloatingPlayer
        vid="v1"
        seriesId="123"
        load={load}
        save={async () => ({})}
        loadEpisodes={async () => episodes}
      />,
    );
    const first = (await screen.findByLabelText('悬浮小窗播放')) as HTMLVideoElement;
    Object.defineProperty(first, 'currentTime', { value: 100, configurable: true });
    Object.defineProperty(first, 'duration', { value: 100, configurable: true });
    fireEvent.ended(first);
    await waitFor(() => expect(load).toHaveBeenLastCalledWith('v2', '123'));

    // 第 2 集播完，下一集是锁定的第 3 集：不自动播
    const second = (await screen.findByLabelText('悬浮小窗播放')) as HTMLVideoElement;
    Object.defineProperty(second, 'currentTime', { value: 100, configurable: true });
    Object.defineProperty(second, 'duration', { value: 100, configurable: true });
    fireEvent.ended(second);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(load).toHaveBeenLastCalledWith('v2', '123');
  });
});
