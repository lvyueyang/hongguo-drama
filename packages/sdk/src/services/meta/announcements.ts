// 迁移自 4.5 src/native/app-announcements.js（破坏性重构 M1）。算法未改动，仅模块语法转为 ESM。
const ANNOUNCEMENT_URLS = Object.freeze({
  normal: 'https://raw.githubusercontent.com/jackotom/hongguo-drama/main/announcements/normal.json',
  emergency: 'https://raw.githubusercontent.com/jackotom/hongguo-drama/main/announcements/emergency.json',
});
const EMERGENCY_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const validText = (value, limit, multiline = false) =>
  typeof value === 'string' &&
  value.length <= limit &&
  value.trim().length > 0 &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 这里要拒绝的就是控制字符
  !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
  (multiline || !/[\r\n\t]/.test(value));

function parseAnnouncement(response, urgent) {
  if (
    response?.status !== 200 ||
    typeof response.data !== 'string' ||
    Buffer.byteLength(response.data, 'utf8') > MAX_RESPONSE_BYTES
  )
    return null;
  const type = String(response.headers?.['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!['application/json', 'text/plain'].includes(type)) return null;
  const data = JSON.parse(response.data);
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).length !== 4 ||
    data.active !== true ||
    !validId(data.id) ||
    !validText(data.title, 120) ||
    !validText(data.body, 4000, true)
  )
    return null;
  return { id: data.id, title: data.title.trim(), body: data.body.trim(), urgent };
}

function createAnnouncementService({
  store,
  version,
  request,
  now = Date.now,
  isEnabled = () => true,
  /**
   * 紧急公告的主动推送。传入这个回调才叫「推送」——4.5 是轮询到新公告就推给渲染层；
   * 重构时这里漏了调用，于是主进程注册的回调永远不触发、紧急公告再也弹不出来。
   */
  onAnnouncement,
}: {
  store: any;
  version: string;
  request: (url: string, options: any) => Promise<any>;
  now?: () => number;
  isEnabled?: () => boolean;
  onAnnouncement?: (payload: { announcement: any }) => void;
}) {
  let normalRequest: any = null;
  let emergencyRequest: any = null;
  let manualRequest: any = null;
  let lastEmergencyAttempt = -Infinity;
  let latestEmergency: any = null;
  let normalGeneration = 0;
  let emergencyGeneration = 0;
  let seenUrgentIds: any = null;
  const receivedUrgentIds = new Set();
  const pushedUrgentIds = new Set();

  function getAnnouncementPreferences() {
    const preferences = store.getAnnouncementState().preferences;
    return {
      normalEnabled: preferences?.normalEnabled !== false,
      emergencyEnabled: preferences?.emergencyEnabled !== false,
    };
  }

  function seenIds() {
    if (!seenUrgentIds) {
      const saved = store.getAnnouncementState().seenUrgentIds;
      seenUrgentIds = new Set(Array.isArray(saved) ? saved.filter(validId) : []);
    }
    return seenUrgentIds;
  }

  function localDay() {
    const date = new Date(now());
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function normalSuppressed() {
    const suppression = store.getAnnouncementState().normalSuppression;
    return (
      suppression?.version === version &&
      (suppression.mode === 'version' || (suppression.mode === 'day' && suppression.day === localDay()))
    );
  }

  async function fetchAnnouncement(channel) {
    try {
      const response = await request(ANNOUNCEMENT_URLS[channel], {
        timeout: 6000,
        signal: AbortSignal.timeout(6000),
        maxRedirects: 0,
        maxContentLength: MAX_RESPONSE_BYTES,
        responseType: 'text',
        transformResponse: [(data) => data],
        validateStatus: (status) => status === 200,
        headers: { Accept: 'application/json', 'User-Agent': 'Hongguo-Drama-Announcements' },
      });
      return parseAnnouncement(response, channel === 'emergency');
    } catch (_) {
      return null;
    }
  }

  function checkEmergency() {
    if (emergencyRequest) return emergencyRequest;
    if (now() - lastEmergencyAttempt < EMERGENCY_INTERVAL_MS) return Promise.resolve(latestEmergency);
    lastEmergencyAttempt = now();
    const generation = emergencyGeneration;
    emergencyRequest = fetchAnnouncement('emergency')
      .then((announcement) => {
        latestEmergency =
          generation === emergencyGeneration && isEnabled() && getAnnouncementPreferences().emergencyEnabled
            ? announcement
            : null;
        return latestEmergency;
      })
      .finally(() => {
        emergencyRequest = null;
      });
    return emergencyRequest;
  }

  async function checkAnnouncements(options: any = {}) {
    try {
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        (options.urgentOnly !== undefined && typeof options.urgentOnly !== 'boolean') ||
        !isEnabled()
      ) {
        return { announcement: null };
      }
      const preferences = getAnnouncementPreferences();
      const normalEpoch = normalGeneration;
      const emergencyEpoch = emergencyGeneration;
      let normal = null;
      if (!options.urgentOnly && preferences.normalEnabled && !normalSuppressed()) {
        if (!normalRequest) {
          normalRequest = fetchAnnouncement('normal').then((announcement) =>
            normalEpoch === normalGeneration ? announcement : null,
          );
        }
        normal = normalRequest;
      }
      const emergency = preferences.emergencyEnabled ? await checkEmergency() : null;
      if (!isEnabled()) return { announcement: null };
      if (
        emergency &&
        emergencyEpoch === emergencyGeneration &&
        getAnnouncementPreferences().emergencyEnabled &&
        !seenIds().has(emergency.id)
      ) {
        receivedUrgentIds.add(emergency.id);
        // 主动推一次；同一条公告在用户读完（确认）之前会反复被轮询到，这里只推新的。
        if (!pushedUrgentIds.has(emergency.id)) {
          pushedUrgentIds.add(emergency.id);
          try {
            onAnnouncement?.({ announcement: emergency });
          } catch (_) {
            /* 推送失败不影响本次轮询结果 */
          }
        }
        return { announcement: emergency };
      }
      const announcement = await normal;
      return {
        announcement:
          isEnabled() &&
          normalEpoch === normalGeneration &&
          getAnnouncementPreferences().normalEnabled &&
          !normalSuppressed()
            ? announcement
            : null,
      };
    } catch (_) {
      return { announcement: null };
    }
  }

  async function getCurrentAnnouncement() {
    const unavailable: any = {
      announcement: null,
      error: '当前环境无法读取公告，请退出预览模式或修复代理设置后重试。',
    };
    if (!isEnabled()) return unavailable;
    if (!manualRequest) {
      manualRequest = Promise.all([fetchAnnouncement('emergency'), fetchAnnouncement('normal')])
        .then(([emergency, normal]) => {
          if (!isEnabled()) return unavailable;
          const announcement = emergency || normal;
          if (!announcement)
            return { announcement: null, error: '当前暂无可查看的公告，或暂时无法读取，请稍后重试。' };
          if (announcement.urgent) receivedUrgentIds.add(announcement.id);
          return { announcement };
        })
        .finally(() => {
          manualRequest = null;
        });
    }
    return manualRequest;
  }

  function acknowledgeAnnouncement(payload) {
    if (!validId(payload?.id) || !receivedUrgentIds.has(payload.id)) {
      return { success: false, error: '公告无效或尚未展示。' };
    }
    const seen = seenIds();
    // Keep the in-process read mark even if the atomic store write fails.
    seen.add(payload.id);
    try {
      store.saveAnnouncementState({ seenUrgentIds: [...seen] });
      return { success: true };
    } catch (_) {
      return { success: false, error: '公告已在本次运行中记为已读，但未能保存；重启后可能再次显示。' };
    }
  }

  function dismissAnnouncement(payload) {
    if (!['day', 'version'].includes(payload?.mode)) return { success: false, error: '公告免提醒方式无效。' };
    try {
      store.saveAnnouncementState({ normalSuppression: { mode: payload.mode, version, day: localDay() } });
      return { success: true };
    } catch (_) {
      return { success: false, error: '普通公告免提醒设置保存失败，请检查磁盘空间或目录权限后重试。' };
    }
  }

  function setAnnouncementPreferences(patch) {
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.entries<any>(patch).some(
        ([key, value]) => !['normalEnabled', 'emergencyEnabled'].includes(key) || typeof value !== 'boolean',
      )
    ) {
      return { success: false, error: '公告开关设置无效。' };
    }
    try {
      const previous = getAnnouncementPreferences();
      const preferences: any = { ...previous, ...patch };
      store.saveAnnouncementState({ preferences });
      // Invalidate checks started before the switch, even if it is quickly turned back on.
      if (preferences.normalEnabled !== previous.normalEnabled) normalGeneration++;
      if (preferences.emergencyEnabled !== previous.emergencyEnabled) {
        emergencyGeneration++;
        latestEmergency = null;
      }
      return { success: true, preferences };
    } catch (_) {
      return { success: false, error: '公告开关保存失败，请检查磁盘空间或目录权限后重试。' };
    }
  }

  return {
    checkAnnouncements,
    getCurrentAnnouncement,
    acknowledgeAnnouncement,
    dismissAnnouncement,
    getAnnouncementPreferences,
    setAnnouncementPreferences,
  };
}

export default {
  createAnnouncementService,
};
export { createAnnouncementService };
