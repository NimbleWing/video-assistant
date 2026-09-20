import { describe, expect, it } from 'vitest';
import { dirName, normPath, stemOf, typeOfExt, volumeOf } from './paths.ts';

describe('normPath', () => {
  it('反斜杠转正斜杠 + 去前导斜杠 + 小写', () => {
    expect(normPath('D:\\Videos\\A.MP4')).toBe('d:/videos/a.mp4');
    expect(normPath('/g:/x/y.mp4')).toBe('g:/x/y.mp4');
  });
});

describe('stemOf', () => {
  it('去最后一个扩展名段并小写', () => {
    expect(stemOf('Episode.01.CHINESE.mp4')).toBe('episode.01.chinese');
    expect(stemOf('COVER.JPG')).toBe('cover');
  });
  it('无扩展名原样小写', () => {
    expect(stemOf('NoExt')).toBe('noext');
  });
});

describe('volumeOf', () => {
  it('大小写盘符统一小写', () => {
    expect(volumeOf('D:/x/y.mp4')).toBe('d:');
    expect(volumeOf('g:\\x\\y.mp4')).toBe('g:');
  });
  it('非 Windows 形态返回 ?', () => {
    expect(volumeOf('/home/x.mp4')).toBe('?');
  });
});

describe('typeOfExt', () => {
  it('视频/封面扩展', () => {
    expect(typeOfExt('mp4')).toBe('video');
    expect(typeOfExt('TS')).toBe('video');
    expect(typeOfExt('.jpg')).toBe('cover');
    expect(typeOfExt('jpeg')).toBe('cover');
    expect(typeOfExt('png')).toBe('cover');
    expect(typeOfExt('webp')).toBe('cover');
  });
  it('未知返回 null', () => {
    expect(typeOfExt('txt')).toBeNull();
    expect(typeOfExt('')).toBeNull();
  });
});

describe('dirName（女优目录树目录段清洗）', () => {
  it('Windows 非法字符替换为空格并压缩', () => {
    expect(dirName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });
  it('尾部点/空格剥除（系统会静默剥）', () => {
    expect(dirName('名字. ')).toBe('名字');
  });
  it('清洗后为空回退 unnamed', () => {
    expect(dirName('???')).toBe('unnamed');
    expect(dirName('')).toBe('unnamed');
  });
  it('正常名字原样保留', () => {
    expect(dirName('樱空桃')).toBe('樱空桃');
  });
});
