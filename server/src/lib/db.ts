// 数据库连接单例：media.db 锚定 server 根（src/.. 相对定位，不依赖 cwd）。
// 仅此文件创建连接；各 feature 自持表 DDL。env ROU_MEDIA_DB 覆盖路径（测试注入 :memory:）。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DB_PATH = process.env.ROU_MEDIA_DB ?? path.join(SERVER_ROOT, 'media.db');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

/** node:sqlite 行（值可能为 null/number/bigint/string/Uint8Array，取用时显式转换）。 */
export type SqlRow = Record<string, unknown>;

/** 行值转 number（非法回退 fallback）。 */
export function numOf(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 行值转 string（null/undefined 回退 fallback）。 */
export function strOf(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v);
}
