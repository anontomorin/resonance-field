/**
 * 星级的 DOM 渲染小工具。
 *
 * 单独抽出来是因为三处都要画星星（通关面板、关卡卡片、最终结算），
 * 而且必须长得一模一样——玩家应该能直接对比"这关三星、那关一星"，
 * 而不是每处各画一种。
 */

import { Stars } from '../game/StarRating';

/**
 * 生成三颗星的内联 HTML。
 *
 * 用 ★ / ☆ 文本而不是 emoji：emoji 在不同系统上颜色与大小差异很大，
 * 而且在等宽字体里会被降级成方块；文本星号既能被 CSS 上色，也永远画得出来。
 *
 * @param stars 点亮的星数（0~3）
 */
export function renderStars(stars: number): string {
  const lit = Math.max(0, Math.min(3, Math.floor(stars)));
  let html = '';
  for (let i = 0; i < 3; i += 1) {
    html += `<i class="star${i < lit ? ' on' : ''}">${i < lit ? '★' : '☆'}</i>`;
  }
  return html;
}

/** 把星级渲染进一个已存在的元素（会清空其内容） */
export function paintStars(el: HTMLElement, stars: number): void {
  el.innerHTML = renderStars(stars);
  el.setAttribute('aria-label', `${stars} 星（满分 3 星）`);
}

/** 通关后判断这次是不是刷新了个人纪录（用于"新纪录"角标） */
export function isNewRecord(current: Stars, previous: number): boolean {
  return current > previous;
}
