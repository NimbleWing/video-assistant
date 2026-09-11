export const Logger = {
  debug(cat, msg, data) { console.debug(`[RouVideo:${cat}]`, msg, data || ''); },
  info(cat, msg, data) { console.log(`[RouVideo:${cat}]`, msg, data || ''); },
  warn(cat, msg, data) { console.warn(`[RouVideo:${cat}]`, msg, data || ''); },
  error(cat, msg, data) { console.error(`[RouVideo:${cat}]`, msg, data || ''); },
};
