// 迁移自 4.5 src/native/media-sources.js（破坏性重构 M1）。算法未改动，仅模块语法转为 ESM。
const BUILTIN_SOURCES = [
  { id: 'hongguo', label: '红果' },
  { id: 'xifan', label: '西饭' },
  { id: 'hema', label: '河马' },
];

function getMediaSources(settings) {
  return [
    ...BUILTIN_SOURCES.filter(
      (source) => source.id === 'hongguo' || settings.builtin_sources?.[source.id] !== false,
    ),
    ...(settings.custom_sources || [])
      .filter((source) => source.enabled)
      .map((source) => ({ id: `custom:${source.id}`, label: source.name, custom: true })),
  ];
}

function setBuiltinSourceEnabled(settings, id, enabled) {
  if (id === 'hongguo') throw new Error('红果来源固定开启，不能关闭');
  if (!['xifan', 'hema'].includes(id) || typeof enabled !== 'boolean') throw new Error('来源开关无效');
  return { ...settings, builtin_sources: { ...settings.builtin_sources, [id]: enabled } };
}

export default {
  getMediaSources,
  setBuiltinSourceEnabled,
};
export { getMediaSources, setBuiltinSourceEnabled };
