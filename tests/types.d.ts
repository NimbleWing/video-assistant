// 测试环境的 happy-dom 全局扩展
interface Window {
  happyDOM: {
    setURL(url: string): void;
  };
}
