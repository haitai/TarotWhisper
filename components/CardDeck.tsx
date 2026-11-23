'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';

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
const COPIES = [0, 1, 2] as const;
const DRAG_THRESHOLD_PX = 6;
const NUDGE_STEP_PX = 260;

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
  const copy0StartRef = useRef<HTMLButtonElement | null>(null);
  const copy1StartRef = useRef<HTMLButtonElement | null>(null);
  const cycleWidthRef = useRef(0);
  const suppressClickRef = useRef(false);
  const dragRef = useRef({
    active: false,
    dragging: false,
    pointerId: -1,
    startX: 0,
    startScrollLeft: 0,
  });

  useEffect(() => {
    return () => {
      window.clearTimeout(shuffleTimer.current);
      window.clearTimeout(completeTimer.current);
    };
  }, []);

  const wrapScroll = useCallback((el: HTMLDivElement): void => {
    const cycleWidth = cycleWidthRef.current;
    if (cycleWidth <= 0 || el.scrollWidth <= el.clientWidth + 4) return;

    const low = cycleWidth * 0.5;
    const high = Math.max(
      low + cycleWidth,
      Math.min(cycleWidth * 2, el.scrollWidth - el.clientWidth - 16),
    );
    const left = el.scrollLeft;

    if (left < low) {
      el.scrollLeft = left + cycleWidth;
      if (dragRef.current.active) {
        dragRef.current.startScrollLeft += cycleWidth;
      }
    } else if (left >= high) {
      el.scrollLeft = left - cycleWidth;
      if (dragRef.current.active) {
        dragRef.current.startScrollLeft -= cycleWidth;
      }
    }
  }, []);

  useEffect(() => {
    if (phase !== 'picking') return;
    const el = scrollRef.current;
    if (!el) return;

    const measureAndCenter = (shouldCenter: boolean): void => {
      const start0 = copy0StartRef.current;
      const start1 = copy1StartRef.current;
      if (!start0 || !start1) return;
      const cycleWidth = start1.offsetLeft - start0.offsetLeft;
      if (cycleWidth <= 0) return;
      cycleWidthRef.current = cycleWidth;
      if (shouldCenter) {
        el.scrollLeft = cycleWidth + Math.max(0, (cycleWidth - el.clientWidth) / 2);
      }
    };

    measureAndCenter(true);

    const handleResize = (): void => measureAndCenter(false);
    const handleWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
        wrapScroll(el);
      }
    };

    window.addEventListener('resize', handleResize);
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('resize', handleResize);
      el.removeEventListener('wheel', handleWheel);
    };
  }, [phase, pool.length, wrapScroll]);

  const startShuffle = (): void => {
    if (disabled || phase === 'shuffling') return;
    window.clearTimeout(shuffleTimer.current);
    window.clearTimeout(completeTimer.current);

    setPickedIndices([]);
    setPhase('shuffling');

    shuffleTimer.current = window.setTimeout(() => {
      setPool(createFanPool(undefined, excludeCardIds));
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

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || disabled) return;
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = {
      active: true,
      dragging: false,
      pointerId: e.pointerId,
      startX: e.clientX,
      startScrollLeft: el.scrollLeft,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const el = scrollRef.current;
    if (!drag.active || !el || e.pointerId !== drag.pointerId) return;

    const dx = e.clientX - drag.startX;
    if (!drag.dragging) {
      if (Math.abs(dx) <= DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      suppressClickRef.current = true;
      el.classList.add('deck-ribbon-dragging');
      el.setPointerCapture?.(e.pointerId);
    }

    el.scrollLeft = drag.startScrollLeft - dx;
    wrapScroll(el);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const el = scrollRef.current;
    if (!drag.active || !el || e.pointerId !== drag.pointerId) return;

    const wasDragging = drag.dragging;
    drag.active = false;
    drag.dragging = false;
    el.classList.remove('deck-ribbon-dragging');
    if (el.hasPointerCapture?.(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
    if (wasDragging) {
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  };

  const nudgeRibbon = (direction: -1 | 1): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * NUDGE_STEP_PX, behavior: 'smooth' });
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

    const cardSizeClass = compact
      ? 'h-[6.6rem] w-[4rem]'
      : 'h-[7.5rem] w-[4.5rem]';
    const overlapClass = compact
      ? '-ml-9 first:ml-0'
      : '-ml-10 first:ml-0';

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

        <div className="relative mt-2 w-full">
          <button
            type="button"
            onClick={() => nudgeRibbon(-1)}
            disabled={disabled}
            aria-label="向左滑动牌堆"
            className="absolute left-1 top-1/2 z-10 grid h-8 w-8 -translate-y-1/2 cursor-pointer place-items-center rounded-full border border-line-strong bg-surface/90 text-ink-soft shadow-[var(--shadow-paper)] backdrop-blur-xs transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d="m10 3-5 5 5 5" />
            </svg>
          </button>

          <div
            ref={scrollRef}
            onScroll={(e) => wrapScroll(e.currentTarget)}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="deck-ribbon relative z-0 w-full cursor-grab overflow-x-auto pt-10 pb-6"
          >
            <div className="flex w-max items-end px-8">
              {COPIES.flatMap((copy) =>
                pool.map((candidate, index) => {
                  const isPicked = pickedIndices.includes(index);
                  const isMiddleCopy = copy === 1;
                  const globalIndex = copy * pool.length + index;
                  const wavePhase = pool.length > 0 ? (index / pool.length) * Math.PI * 2 * 6 : 0;
                  const angle = Math.sin(wavePhase) * 2.2;
                  const offsetY = Math.round((1 - Math.cos(wavePhase)) * 3);
                  const cardStyle = {
                    '--fan-z': globalIndex + 1,
                    '--fan-angle': `${angle.toFixed(2)}deg`,
                    '--fan-y': `${offsetY}px`,
                  } as CSSProperties;

                  return (
                    <button
                      key={`${copy}-${candidate.card.id}`}
                      ref={
                        copy === 0 && index === 0
                          ? copy0StartRef
                          : copy === 1 && index === 0
                            ? copy1StartRef
                            : undefined
                      }
                      type="button"
                      onClick={() => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false;
                          return;
                        }
                        handlePick(index);
                      }}
                      disabled={disabled || isPicked || isDone}
                      tabIndex={isMiddleCopy && !isPicked ? 0 : -1}
                      aria-hidden={!isMiddleCopy || undefined}
                      aria-label={
                        isMiddleCopy
                          ? `第 ${index + 1} 张暗牌${isPicked ? '（已选）' : ''}`
                          : undefined
                      }
                      style={cardStyle}
                      className={`fan-card card-back shrink-0 cursor-pointer ${cardSizeClass} ${overlapClass} ${
                        isPicked ? 'is-picked' : ''
                      }`}
                    >
                      <CardMedallion />
                    </button>
                  );
                }),
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => nudgeRibbon(1)}
            disabled={disabled}
            aria-label="向右滑动牌堆"
            className="absolute right-1 top-1/2 z-10 grid h-8 w-8 -translate-y-1/2 cursor-pointer place-items-center rounded-full border border-line-strong bg-surface/90 text-ink-soft shadow-[var(--shadow-paper)] backdrop-blur-xs transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d="m6 3 5 5-5 5" />
            </svg>
          </button>
        </div>

        <p className="text-center text-xs text-ink-muted">
          共 {pool.length} 张牌，可左右循环滑动挑选
        </p>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-5 text-sm">
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
