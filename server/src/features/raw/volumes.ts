// 盘符探测：A:–Z: 逐个检查根下 RawFiles/ 目录，只返回存在的盘（附 statfs 容量）。
// 网络盘等无盘符形态不支持（判定依据是盘符根目录，约定见 DESIGN.md §6 raw）。
import { promises as fs } from 'node:fs';
import type { RawVolume } from './types.ts';

/** 盘符 → RawFiles 根目录（'d:' → 'd:/RawFiles'）。 */
export function rawRootOf(volume: string): string {
  return `${volume}/RawFiles`;
}

/** 探测全部可用原始资料盘符（并行 stat，26 个字母瞬间完成）。 */
export async function probeRawVolumes(): Promise<RawVolume[]> {
  const out = await Promise.all(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (L): Promise<RawVolume | null> => {
      const volume = `${L.toLowerCase()}:`;
      try {
        const st = await fs.stat(rawRootOf(volume));
        if (!st.isDirectory()) return null;
        let total = 0;
        let free = 0;
        try {
          const sf = await fs.statfs(`${volume}/`);
          total = Number(sf.blocks) * Number(sf.bsize);
          free = Number(sf.bavail) * Number(sf.bsize);
        } catch { /* statfs 不可用时容量为 0，仅影响展示 */ }
        return { volume, total, free };
      } catch {
        return null; // 无此盘 / 无 RawFiles 目录
      }
    }),
  );
  return out.filter((v): v is RawVolume => v != null);
}
