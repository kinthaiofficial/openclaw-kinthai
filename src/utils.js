/**
 * Pure utility functions for KinthAI channel plugin.
 * KinthAI 频道插件的纯工具函数。
 */

export function relativeTime(isoString) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function extractMentions(text) {
  const entities = [];
  const re = /@(\w+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    entities.push({ type: 'mention', user: m[1] });
  }
  return entities;
}

export function sanitizeFileName(name) {
  return name.replace(/[^\w.\-]/g, '_').slice(0, 100);
}
