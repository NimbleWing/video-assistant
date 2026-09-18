// 必须在任何 src 模块 import 前执行（setupFiles 保证）：内存库替换 media.db 文件。
process.env.ROU_MEDIA_DB ??= ':memory:';
