/**
 * 统一日志出口：带固定前缀与分类，便于在页面控制台过滤。
 * @type {{
 *   debug(cat: string, msg: string, data?: unknown): void,
 *   info(cat: string, msg: string, data?: unknown): void,
 *   warn(cat: string, msg: string, data?: unknown): void,
 *   error(cat: string, msg: string, data?: unknown): void,
 * }}
 */
export const Logger = {
  debug(cat, msg, data) { console.debug(`[RouVideo:${cat}]`, msg, data || ''); },
  info(cat, msg, data) { console.log(`[RouVideo:${cat}]`, msg, data || ''); },
  warn(cat, msg, data) { console.warn(`[RouVideo:${cat}]`, msg, data || ''); },
  error(cat, msg, data) { console.error(`[RouVideo:${cat}]`, msg, data || ''); },
};
