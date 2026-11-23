/**
 * 抽牌纯函数 · 神谕选牌与亲手抽牌共用。
 *
 * 抽牌逻辑：从 allCards 中 Fisher-Yates 洗牌后按牌阵位置取出，
 * 每张以 50% 概率逆位。无副作用、无 React 依赖。
 */

import { allCards } from '@/lib/tarot/cards';
import { DrawnCard, Spread, SpreadPosition, TarotCard } from '@/lib/tarot/types';

/** 待翻开的候选牌（尚未绑定到具体阵位） */
export interface DrawnCandidate {
  card: TarotCard;
  isReversed: boolean;
}

/** Fisher-Yates 洗牌，返回新数组 */
export function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** 生成用于挑牌的候选暗牌池（默认包含过滤后的全副剩余牌） */
export function createFanPool(
  size = allCards.length,
  excludeCardIds?: readonly string[],
): DrawnCandidate[] {
  if (size <= 0) return [];
  const excluded = excludeCardIds && excludeCardIds.length > 0 ? new Set(excludeCardIds) : null;
  const available = excluded
    ? allCards.filter((card) => !excluded.has(card.id))
    : allCards;
  const shuffled = shuffle(available);
  const count = Math.min(size, shuffled.length);

  return shuffled.slice(0, count).map((card) => ({
    card,
    isReversed: Math.random() > 0.5,
  }));
}

/** 洗牌并按牌阵位置抽取 */
export function drawCardsForSpread(spread: Spread): DrawnCard[] {
  const shuffled = shuffle(allCards);
  return spread.positions.map((position, index) => ({
    card: shuffled[index],
    isReversed: Math.random() > 0.5,
    position,
  }));
}

// ─── 补充牌（追问用） ───────────────────────────────────────

const SUPPLEMENTARY_CN_NAMES = ['补 一', '补 二', '补 三', '补 四', '补 五'];

export function makeSupplementaryPositions(
  count: number,
  startIndex = 0,
): SpreadPosition[] {
  return Array.from({ length: count }, (_, i) => {
    const idx = startIndex + i;
    return {
      id: `supp-${idx + 1}`,
      name: `Supplementary ${idx + 1}`,
      nameCn: SUPPLEMENTARY_CN_NAMES[i] ?? `补 ${idx + 1}`,
      description: '为回应追问而抽取的补充指引',
    };
  });
}

/** 抽取追问用的补充指引牌 */
export function drawSupplementaryCards(
  count: number,
  startIndex = 0,
  excludeCardIds?: readonly string[],
): DrawnCard[] {
  if (count <= 0) return [];
  const positions = makeSupplementaryPositions(count, startIndex);
  const excluded = excludeCardIds && excludeCardIds.length > 0 ? new Set(excludeCardIds) : null;
  const available = excluded
    ? allCards.filter((card) => !excluded.has(card.id))
    : allCards;
  const shuffled = shuffle(available);
  const usableCount = Math.min(positions.length, shuffled.length);

  return positions.slice(0, usableCount).map((position, idx) => ({
    card: shuffled[idx],
    isReversed: Math.random() > 0.5,
    position,
  }));
}
