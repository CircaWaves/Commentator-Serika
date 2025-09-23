// 입력 버블 초기화. 아이콘 엘리먼트에 data-commenter-icon 속성을 달아두면 자동 부착됩니다.

export function initCommenterInputBubble() {
const ICON_SELECTORS = [
'[data-commenter-icon]',
'.commenter-icon',
'#commenter-icon'
];


let iconEl = null;
for (const sel of ICON_SELECTORS) {
const el = document.querySelector(sel);
if (el) { iconEl = el; break; }
}


// 없으면 종료
if (!iconEl) return;


// 버블 DOM 생성
const bubble = document.createElement('div');
bubble.id = 'commenter-input-bubble';
bubble.innerHTML = `
<input id="commenter-input" type="text" placeholder="<여기에 입력할 수 있게>" autocomplete="off" />
<div class="hint">Enter: 캡처 & 코멘트 · Esc: 닫기</div>
`;
document.body.appendChild(bubble);


const input = bubble.querySelector('#commenter-input');


function openBubble() {
// 포인터 인터랙션 허용, 오버레이에 포커스 부여
window.api?.setOverlayPassthrough(false);
window.focus?.();


// 아이콘 기준 위치 계산(오른쪽 8px)
const r = iconEl.getBoundingClientRect();
const gap = 8;
bubble.style.left = Math.round(r.right + gap) + 'px';
bubble.style.top = Math.round(r.top) + 'px';
bubble.style.display = 'block';


setTimeout(() => input.focus(), 0);
}


function closeBubble() {
bubble.style.display = 'none';
input.value = '';
// 다시 클릭 통과 모드
window.api?.setOverlayPassthrough(true);
}


// 아이콘 클릭 → 열기
iconEl.addEventListener('click', (e) => {
e.preventDefault();
openBubble();
});


// 외부 클릭 → 닫기
document.addEventListener('mousedown', (e) => {
if (bubble.style.display !== 'block') return;
if (!bubble.contains(e.target) && e.target !== iconEl) {
closeBubble();
}
});


// 키 처리 (Enter 제출, Esc 닫기)
input.addEventListener('keydown', async (e) => {
if (e.isComposing || e.keyCode === 229) return; // IME 조합 중이면 무시
if (e.key === 'Enter') {
e.preventDefault();
const text = input.value.trim();
closeBubble();
try {
await window.api?.triggerComment(text);
} catch (err) {
console.error('triggerComment error', err);
}
} else if (e.key === 'Escape') {
e.preventDefault();
closeBubble();
}
});
}