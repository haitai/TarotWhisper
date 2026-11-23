import { describe, it, expect } from 'vitest';
import { allCards } from '@/lib/tarot/cards';
import { getSpreadById } from '@/lib/tarot/spreads';
import {
  createFanPool,
  drawCardsForSpread,
  drawSupplementaryCards,
  makeSupplementaryPositions,
  shuffle,
} from '@/lib/tarot/draw';

describe('抽牌工具函数', () => {
  it('shuffle 返回等长新数组且不改变原数组', () => {
    const original = [1, 2, 3, 4, 5, 6];
    const snapshot = [...original];
    const result = shuffle(original);

    expect(original).toEqual(snapshot);
    expect(result).not.toBe(original);
    expect(result).toHaveLength(original.length);
    expect([...result].sort((a, b) => a - b)).toEqual(original);
  });

  it('createFanPool 生成指定数量且不重复的候选暗牌', () => {
    const pool = createFanPool(22);
    expect(pool).toHaveLength(22);

    const ids = pool.map((item) => item.card.id);
    expect(new Set(ids).size).toBe(22);
    pool.forEach((item) => {
      expect(typeof item.isReversed).toBe('boolean');
    });
  });

  it('createFanPool 正确排除已抽出的牌并在余牌不足时安全截断', () => {
    const excluded = allCards.slice(0, 70).map((c) => c.id);
    const pool = createFanPool(22, excluded);

    expect(pool).toHaveLength(allCards.length - 70);
    const excludedSet = new Set(excluded);
    pool.forEach((item) => {
      expect(excludedSet.has(item.card.id)).toBe(false);
    });

    expect(createFanPool(0)).toEqual([]);
  });

  it('drawCardsForSpread 为牌阵每个位置抽出不重复的牌', () => {
    const spread = getSpreadById('celtic-cross')!;
    const drawn = drawCardsForSpread(spread);

    expect(drawn).toHaveLength(spread.positions.length);
    const cardIds = drawn.map((d) => d.card.id);
    expect(new Set(cardIds).size).toBe(spread.positions.length);
    drawn.forEach((d, idx) => {
      expect(d.position.id).toBe(spread.positions[idx].id);
    });
  });

  it('makeSupplementaryPositions 生成对应数量的补充阵位', () => {
    const positions = makeSupplementaryPositions(3, 1);
    expect(positions).toHaveLength(3);
    expect(positions.map((p) => p.id)).toEqual(['supp-2', 'supp-3', 'supp-4']);
    expect(positions.map((p) => p.nameCn)).toEqual(['补 一', '补 二', '补 三']);
  });

  it('drawSupplementaryCards 支持去重并排除指定牌 ID', () => {
    const excluded = allCards.slice(0, 75).map((c) => c.id);
    const drawn = drawSupplementaryCards(3, 0, excluded);

    expect(drawn).toHaveLength(3);
    const excludedSet = new Set(excluded);
    const ids = drawn.map((d) => d.card.id);
    expect(new Set(ids).size).toBe(3);
    ids.forEach((id) => expect(excludedSet.has(id)).toBe(false));
  });
});
