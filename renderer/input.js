// renderer/input.js
 const input = document.getElementById('q');
 let grown = false;
 let submitted = false;

window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => input.focus({ preventScroll: true }), 0);
  // 열릴 때 180 -> 240 한 번 확장
  setTimeout(() => {
    if (!grown) {
      window.apiInput.resize({ width: 240 });
      grown = true;
    }
  }, 60);
});


// Enter: 제출(Shift+Enter는 줄바꿈), Esc: 취소
    input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (submitted || e.repeat) return;     // ★ 중복/반복 차단
      e.preventDefault();
      submitted = true;
      const v = input.value.trim();
      window.apiInput.submit(v);
    } else if (e.key === 'Escape') {
    e.preventDefault();
    window.apiInput.cancel();
      } else {
    // 최초 타이핑 시에도 확장 보장(혹시 DOMContentLoaded 타이밍 놓친 경우)
    if (!grown) {
      window.apiInput.resize({ width: 240 });
      grown = true;
    }
   }
});


// 창 바깥 클릭/포커스 아웃 시 닫기(선택)
window.addEventListener('blur', () => {
  if (!submitted) window.apiInput.cancel(); // ★ 이미 submit했다면 취소 안 보냄
});