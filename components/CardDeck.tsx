'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';

import { CardMedallion } from '@/components/TarotCard';
import { createFanPool, shuffle, type DrawnCandidate } from '@/lib/tarot/draw';
import type { DrawnCard, SpreadPosition } from '@/lib/tarot/types';

interface CardDeckProps {
  positions: SpreadPosition[];
  excludeCardIds?: string[];
  onComplete: (drawnCards: DrawnCard[]) => void;
  onQuickDraw?: () => void;
  quickDrawLabel?: string;
  compact?: boolean;
  disabled?: boolean;
}

type DeckPhase = 'idle' | 'shuffling' | 'picking';

const DECK_SIZE = 5;
const SHUFFLE_MS = 1500;
const PICK_COMPLETE_MS = 260;

function buildDrawnCards(
  pool: readonly DrawnCandidate[],
  indices: readonly number[],
  positions: readonly SpreadPosition[],
): DrawnCard[] {
  return indices.slice(0, positions.length).map((poolIndex, posIndex) => {
    const candidate = pool[poolIndex];
    return {
      card: candidate.card,
      isReversed: candidate.isReversed,
      position: positions[posIndex],
    };
  });
}

export function CardDeck({
  positions,
  excludeCardIds,
  onComplete,
  onQuickDraw,
  quickDrawLabel = '替我抽',
  compact = false,
  disabled = false,
}: CardDeckProps): ReactElement {
  const [phase, setPhase] = useState<DeckPhase>('idle');
  const [pool, setPool] = useState<DrawnCandidate[]>([]);
  const [pickedIndices, setPickedIndices] = useState<number[]>([]);

  const shuffleTimer = useRef(0);
  const completeTimer = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      window.clearTimeout(shuffleTimer.current);
      window.clearTimeout(completeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (phase !== 'picking') return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, [phase, pool.length]);

  const startShuffle = (): void => {
    if (disabled || phase === 'shuffling') return;
    window.clearTimeout(shuffleTimer.current);
    window.clearTimeout(completeTimer.current);

    setPickedIndices([]);
    setPhase('shuffling');

    shuffleTimer.current = window.setTimeout(() => {
      const fanSize = compact ? Math.max(12, positions.length + 6) : 22;
      setPool(createFanPool(fanSize, excludeCardIds));
      setPhase('picking');
    }, SHUFFLE_MS);
  };

  const handlePick = (index: number): void => {
    if (disabled || phase !== 'picking') return;
    if (pickedIndices.length >= positions.length || pickedIndices.includes(index)) return;

    const nextIndices = [...pickedIndices, index];
    setPickedIndices(nextIndices);

    if (nextIndices.length >= positions.length) {
      const drawnCards = buildDrawnCards(pool, nextIndices, positions);
      window.clearTimeout(completeTimer.current);
      completeTimer.current = window.setTimeout(() => {
        onComplete(drawnCards);
      }, PICK_COMPLETE_MS);
    }
  };

  const handleAutoFinish = (): void => {
    if (disabled || phase !== 'picking' || pickedIndices.length >= positions.length) return;

    const pickedSet = new Set(pickedIndices);
    const remaining = pool.map((_, i) => i).filter((i) => !pickedSet.has(i));
    const needed = positions.length - pickedIndices.length;
    const finalIndices = [...pickedIndices, ...shuffle(remaining).slice(0, needed)];

    setPickedIndices(finalIndices);
    const drawnCards = buildDrawnCards(pool, finalIndices, positions);
    window.clearTimeout(completeTimer.current);
    completeTimer.current = window.setTimeout(() => {
      onComplete(drawnCards);
    }, PICK_COMPLETE_MS);
  };

  if (phase === 'picking') {
    const total = positions.length;
    const pickedCount = pickedIndices.length;
    const isDone = pickedCount >= total;
    const currentPos = positions[Math.min(pickedCount, total - 1)];

    let guideText: string;
    if (isDone) {
      guideText = '已选好，正在摆牌…';
    } else if (total === 1) {
      guideText = '凭直觉挑一张牌';
    } else {
      guideText = `为「${currentPos.nameCn}」挑一张牌（${pickedCount + 1} / ${total}）`;
    }

    const fanSpreadAngle = compact ? 12 : 16;
    const fanDropY = compact ? 12 : 20;
    const cardSizeClass = compact
      ? 'h-24 w-[3.6rem] sm:h-28 sm:w-[4.2rem]'
      : 'h-[6.5rem] w-[3.9rem] sm:h-[7.5rem] sm:w-[4.5rem]';
    const overlapClass = compact
      ? '-ml-7 first:ml-0 sm:-ml-8'
      : '-ml-[2.1rem] first:ml-0 sm:-ml-[2.85rem]';

    return (
      <div className="flex flex-col items-center">
        <p className="text-center text-sm font-medium text-ink" role="status">
          {guideText}
        </p>

        {total > 1 && (
          <ol
            className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs"
            aria-label="选牌阵位进度"
          >
            {positions.map((pos, idx) => {
              const isPickedPos = idx < pickedCount;
              const isCurrentPos = idx === pickedCount;
              return (
                <li
                  key={pos.id}
                  className={
                    isCurrentPos
                      ? 'font-semibold text-accent'
                      : isPickedPos
                        ? 'text-ink'
                        : 'text-ink-muted'
                  }
                >
                  {isPickedPos ? `✓ ${pos.nameCn}` : pos.nameCn}
                </li>
              );
            })}
          </ol>
        )}

        <div
          ref={scrollRef}
          className="mt-2 w-full overflow-x-auto px-6 pt-11 pb-9"
        >
          <div className="mx-auto flex w-max items-end justify-center">
            {pool.map((candidate, index) => {
              const isPicked = pickedIndices.includes(index);
              const t = pool.length > 1 ? (index / (pool.length - 1)) * 2 - 1 : 0;
              const angle = t * fanSpreadAngle;
              const offsetY = Math.round(t * t * fanDropY);
              const cardStyle = {
                zIndex: index + 1,
                '--fan-angle': `${angle.toFixed(2)}deg`,
                '--fan-y': `${offsetY}px`,
              } as CSSProperties;

              return (
                <button
                  key={candidate.card.id}
                  type="button"
                  onClick={() => handlePick(index)}
                  disabled={disabled || isPicked || isDone}
                  tabIndex={isPicked ? -1 : 0}
                  aria-label={`第 ${index + 1} 张暗牌${isPicked ? '（已选）' : ''}`}
                  style={cardStyle}
                  className={`fan-card card-back shrink-0 cursor-pointer ${cardSizeClass} ${overlapClass} ${
                    isPicked ? 'is-picked' : ''
                  }`}
                >
                  <CardMedallion />
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-1 flex flex-wrap items-center justify-center gap-5 text-sm">
          <button
            type="button"
            onClick={startShuffle}
            disabled={disabled || isDone}
            className="link disabled:cursor-not-allowed disabled:opacity-45"
          >
            重新洗牌
          </button>
          <button
            type="button"
            onClick={handleAutoFinish}
            disabled={disabled || isDone}
            className="text-ink-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
          >
            帮我选完
          </button>
        </div>
      </div>
    );
  }

  const isShuffling = phase === 'shuffling';
  const deckSizeClass = compact ? 'h-32 w-20' : 'h-40 w-24';

  return (
    <div className="flex flex-col items-center gap-5">
      <div className={`relative ${deckSizeClass} ${isShuffling ? 'is-shuffling' : ''}`} aria-hidden>
        {Array.from({ length: DECK_SIZE }, (_, i) => (
          <div
            key={i}
            className="deck-card card-back"
            style={{ translate: `${i * 2}px ${-i * 2}px` }}
          >
            {i === DECK_SIZE - 1 && <CardMedallion />}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={startShuffle}
          disabled={disabled || isShuffling}
          className={`btn btn-primary ${compact ? 'h-10 px-6 text-sm' : 'h-11 px-7'}`}
        >
          {isShuffling ? '正在洗牌…' : '开始洗牌'}
        </button>
        {onQuickDraw && !isShuffling && (
          <button
            type="button"
            onClick={onQuickDraw}
            disabled={disabled}
            className={`btn btn-secondary ${compact ? 'h-10 px-4 text-sm' : 'h-11 px-5'}`}
          >
            {quickDrawLabel}
          </button>
        )}
      </div>

      <p className="text-[13px] text-ink-muted" role="status">
        {isShuffling ? '在心里默念你的问题' : '洗牌后，由你亲手挑出每一张牌'}
      </p>
    </div>
  );
}
