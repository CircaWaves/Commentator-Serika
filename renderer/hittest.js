// renderer/hittest.js
const api = window.api;

let currentPT = true; // true=통과(on), false=차단(off)
let active = false;
let tipEl = null;
let iconEl = null;
let raf = 0;

function setPT(next) {
  if (next === currentPT) return;
  currentPT = next;
  api.setOverlayPassthrough(next);
}

function onMove(e) {
  if (!active || !tipEl) return;
  // tipEl이 DOM에서 제거되면 바로 비활성화
  if (!document.body.contains(tipEl)) return disableTooltipHitTest();
  if (raf) return;           // rAF로 과도한 hit-test/IPC 억제
  raf = requestAnimationFrame(() => {
    raf = 0;
    const inRect = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top  && e.clientY <= r.bottom
      );
    };
    const inside = inRect(tipEl) || inRect(iconEl);

    // inside면 오버레이가 이벤트를 "잡아야" 하므로 차단(off) => ignore=false
    // 밖이면 통과(on) => ignore=true
    setPT(!inside);
  });
}

export function enableTooltipHitTest(el, icon) {
  tipEl = el;
  iconEl = icon || null;
  if (!tipEl) return disableTooltipHitTest();
  active = true;
  setPT(true); // 시작은 통과
  window.addEventListener('mousemove', onMove, { passive: true });
}

export function disableTooltipHitTest() {
  active = false;
  window.removeEventListener('mousemove', onMove);
  setPT(true); // 항상 통과로 복귀 (안전)
}
