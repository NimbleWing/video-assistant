/** 浏览器可原生解码的视频格式（直连省转码；mkv 靠 Chromium 内置 matroska demuxer，失败回退 HLS）。 */
export const NATIVE_VIDEO_EXTS = new Set(['mp4', 'webm', 'm4v', 'mov', 'mkv']);
