export const CSS = `
:host{position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;display:block}
*{box-sizing:border-box;-webkit-font-smoothing:antialiased}
.hud{
  font-family:"SF Pro Text","Segoe UI Variable","Segoe UI","PingFang SC","Noto Sans SC",sans-serif;
  color:#f7f7fa;
}
.toast{
  position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(8px);
  background:rgba(20,20,22,.92);border:1px solid rgba(255,255,255,.1);color:#fff;
  padding:8px 12px;border-radius:10px;font-size:12px;opacity:0;transition:.18s;pointer-events:none;
}
.toast.on{opacity:1;transform:translateX(-50%)}
.badge{
  position:fixed;left:50%;top:42%;transform:translate(-50%,-50%) scale(.92);
  font-size:64px;font-weight:780;letter-spacing:-.06em;color:#fff;opacity:0;
  text-shadow:0 10px 40px rgba(255,45,106,.55);transition:opacity .12s,transform .12s;pointer-events:none;
}
.badge.on{opacity:1;transform:translate(-50%,-50%)}
`;
