// renderer/input.js
const input = document.getElementById('q');


window.addEventListener('DOMContentLoaded', () => {
setTimeout(() => input.focus({ preventScroll: true }), 0);
});


// Enter: 제출(Shift+Enter는 줄바꿈), Esc: 취소
input.addEventListener('keydown', (e) => {
if (e.key === 'Enter' && !e.shiftKey) {
e.preventDefault();
const v = input.value.trim();
window.apiInput.submit(v);
} else if (e.key === 'Escape') {
e.preventDefault();
window.apiInput.cancel();
}
});


// 창 바깥 클릭/포커스 아웃 시 닫기(선택)
window.addEventListener('blur', () => {
window.apiInput.cancel();
});