// 路径纯函数：归一化 / stem / 盘符 / 目录段清洗（无 IO，全项目唯一实现）。
// （typeOfExt 已随 media feature 退役移除，2026-09-23；raw 侧扩展名清单内聚 features/raw。）

/** 路径归一化：反斜杠→正斜杠、去前导斜杠、小写（Windows 大小写不敏感）。 */
export function normPath(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/** basename 去扩展名（去最后一个 .xxx 段），小写。 */
export function stemOf(basename: string): string {
  return String(basename).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
}

/** 盘符提取：'D:/x/y' → 'd:'（统一小写）；非 Windows 形态返回 '?'。 */
export function volumeOf(p: string): string {
  const m = p.match(/^([A-Za-z]):/);
  return m ? `${m[1].toLowerCase()}:` : '?';
}

/**
 * 目录段清洗：去 Windows 非法字符与控制字符、压缩空白、trim 尾点/空格（会被系统静默剥除）。
 * 清洗后为空回退 'unnamed'。女优目录树（Archives/国家/女优/图集）用。
 */
export function dirName(name: string): string {
  const s = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return s || 'unnamed';
}
