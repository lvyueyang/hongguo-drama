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
    expect(screen.getByText('小窗播放中')).toBeTruthy();
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
