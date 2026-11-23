'use client';

import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import Link from 'next/link';

import { CardDeck } from '@/components/CardDeck';
import { Interpretation } from '@/components/Interpretation';
import { SpreadBoard } from '@/components/SpreadBoard';
import { SpreadSelector } from '@/components/SpreadSelector';
import type { AgentMessage, FollowUpMessage, RitualStage } from '@/hooks/useAgentChat';
import { makeSupplementaryPositions } from '@/lib/tarot/draw';
import type { DrawnCard, Spread } from '@/lib/tarot/types';

export interface OracleLetterActions {
  regenerate: (agentId: string) => void;
  regenerateFollowUp: (agentId: string, followUpId: string) => void;
  chooseSpread: (agentId: string, spread: Spread) => void;
  backToSpreadChoice: (agentId: string) => void;
  completeDraw: (agentId: string, drawnCards: DrawnCard[]) => void;
  quickDraw: (agentId: string) => void;
  reveal: (agentId: string, all?: boolean) => void;
  interpret: (agentId: string) => void;
  handOver: (agentId: string) => void;
  discard: (agentId: string) => void;
  completeFollowUpDraw: (agentId: string, followUpId: string, cards: DrawnCard[]) => void;
  quickDrawFollowUp: (agentId: string, followUpId: string) => void;
  revealFollowUp: (agentId: string, followUpId: string, all?: boolean) => void;
  interpretFollowUp: (agentId: string, followUpId: string) => void;
  discardFollowUp: (agentId: string, followUpId: string) => void;
  openSettings: () => void;
}

interface OracleLetterProps {
  message: AgentMessage;
  /** 有回合正在生成（包括别处发起的） */
  isBusy: boolean;
  canUseApi: boolean;
  actions: OracleLetterActions;
}

/** 牌到达后依次翻开；挂载时已经在场的牌直接显示，不重播 */
function useStaggeredReveal(total: number): number {
  const [count, setCount] = useState(total);
  // 牌被清空（重新抽牌）后从头再翻
  if (count > total) setCount(total);

  useEffect(() => {
    if (count >= total) return;
    const timer = window.setTimeout(() => setCount((c) => c + 1), count === 0 ? 400 : 260);
    return () => window.clearTimeout(timer);
  }, [count, total]);

  return Math.min(count, total);
}

const RITUAL_STEPS = ['选牌阵', '洗牌挑牌', '翻牌', '解读'];
const STEP_NUMERALS = ['一', '二', '三', '四'];
const STAGE_INDEX: Record<RitualStage, number> = { spread: 0, shuffle: 1, reveal: 2 };

function RitualSteps({ current }: { current: number }): ReactElement {
  return (
    <ol className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]" aria-label="抽牌的步骤">
      {RITUAL_STEPS.map((label, i) => (
        <li
          key={label}
          aria-current={i === current ? 'step' : undefined}
          className={`flex items-center gap-2.5 ${
            i === current ? 'font-semibold text-accent' : i < current ? 'text-ink' : 'text-ink-muted'
          }`}
        >
          <span>
            {STEP_NUMERALS[i]} · {label}
          </span>
          {i < RITUAL_STEPS.length - 1 && <span className="h-px w-4 bg-line-strong" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function Section({ children, className = '' }: { children: ReactNode; className?: string }): ReactElement {
  return <div className={`border-t border-dashed border-line px-5 py-6 md:px-8 ${className}`}>{children}</div>;
}

export function OracleLetter({ message, isBusy, canUseApi, actions }: OracleLetterProps): ReactElement {
  const { id, mode, status, spread, drawnCards } = message;
  const isRitual = status === 'ritual';
  const isRevealRitual = isRitual && message.ritualStage === 'reveal' && drawnCards.length > 0;
  const allRevealed = drawnCards.length > 0 && message.revealedCount >= drawnCards.length;
  const autoRevealed = useStaggeredReveal(drawnCards.length);
  const canRegenerate = !isBusy && canUseApi && (status === 'done' || status === 'error');
  const hasLetter = Boolean(message.content || message.error) || status === 'running';

  const boardRevealedCount = isRitual
    ? message.revealedCount
    : mode === 'self' || message.revealedCount >= drawnCards.length
      ? drawnCards.length
      : autoRevealed;

  let title: string;
  if (spread) {
    title = `${mode === 'self' ? '你选了' : '为你选了'}「${spread.nameCn}」 · ${spread.positions.length} 张`;
  } else if (isRitual) {
    title = '先选一个牌阵';
  } else if (status === 'running') {
    title = '神谕正在挑选牌阵…';
  } else {
    title = '这次没能开始';
  }

  return (
    <article className="panel anim-rise">
      <header className="px-5 pb-5 pt-5 md:px-8 md:pt-6">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="kicker">{mode === 'self' ? '亲手抽牌' : '神谕选牌'}</p>
          {isRitual && message.ritualStage && <RitualSteps current={STAGE_INDEX[message.ritualStage]} />}
        </div>
        <h3 className="mt-3 text-[17px] font-semibold text-ink">{title}</h3>
        {mode === 'oracle' && message.spreadReason && (
          <p className="mt-1.5 font-hand text-base leading-relaxed text-ink-soft">{message.spreadReason}</p>
        )}
      </header>

      {isRitual && (message.ritualStage === 'spread' || message.ritualStage === 'shuffle' || !spread) && (
        <RitualDeckSection message={message} isBusy={isBusy} canUseApi={canUseApi} actions={actions} />
      )}

      {drawnCards.length > 0 && spread && (
        <Section>
          {isRevealRitual && (
            <p className="mb-5 text-center text-sm text-ink-soft">
              {allRevealed
                ? '牌都翻开了。'
                : `按阵位顺序翻开，还剩 ${drawnCards.length - message.revealedCount} 张。`}
            </p>
          )}
          <SpreadBoard
            spreadId={spread.id}
            drawnCards={drawnCards}
            revealedCount={boardRevealedCount}
            onRevealNext={isRevealRitual && !allRevealed ? () => actions.reveal(id) : undefined}
          />
          {isRevealRitual && (
            <>
              <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
                {!allRevealed ? (
                  <button
                    type="button"
                    onClick={() => actions.reveal(id, true)}
                    className="btn btn-secondary h-10 px-5 text-sm"
                  >
                    全部翻开
                  </button>
                ) : canUseApi ? (
                  <button
                    type="button"
                    onClick={() => actions.interpret(id)}
                    disabled={isBusy}
                    className="btn btn-primary h-11 px-7"
                  >
                    请神谕解读
                  </button>
                ) : (
                  <>
                    <button type="button" onClick={actions.openSettings} className="btn btn-primary h-11 px-7">
                      先配置 API
                    </button>
                    <p className="w-full text-center text-[13px] text-ink-muted">
                      解读需要连接模型，配置后回到这里继续。
                    </p>
                  </>
                )}
              </div>
              <div className="mt-4 flex justify-center text-sm">
                <button
                  type="button"
                  onClick={() => actions.discard(id)}
                  className="text-ink-muted hover:text-ink"
                >
                  放弃这次
                </button>
              </div>
            </>
          )}
        </Section>
      )}

      {!isRitual && hasLetter && (
        <Section className="pb-7 md:pb-8">
          <Interpretation
            content={message.content}
            isLoading={status === 'running'}
            error={message.error}
            notice={message.notice}
            retry={message.retry}
            drawnCards={drawnCards}
            onOpenSettings={!canUseApi ? actions.openSettings : undefined}
          />
          {(canRegenerate || message.readingId) && status !== 'running' && (
            <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
              {message.readingId && status === 'done' && (
                <Link href={`/history/${message.readingId}`} className="btn btn-ghost h-9 text-sm">
                  在手札中查看
                </Link>
              )}
              {canRegenerate && (
                <button type="button" onClick={() => actions.regenerate(id)} className="btn btn-ghost h-9 text-sm">
                  重新生成
                </button>
              )}
            </div>
          )}
        </Section>
      )}

      {message.followUps.map((fu) => (
        <FollowUpSection
          key={fu.id}
          agent={message}
          followUp={fu}
          isBusy={isBusy}
          canUseApi={canUseApi}
          actions={actions}
        />
      ))}
    </article>
  );
}

/* ─── 选阵、洗牌与扇形挑牌 ─── */

function RitualDeckSection({ message, isBusy, canUseApi, actions }: OracleLetterProps): ReactElement {
  const { id, mode, spread, ritualStage } = message;

  if (ritualStage === 'spread' || !spread) {
    return (
      <Section>
        <SpreadSelector selectedId={spread?.id} onSelect={(s) => actions.chooseSpread(id, s)} />
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <button
            type="button"
            onClick={() => actions.handOver(id)}
            disabled={isBusy || !canUseApi}
            className="link disabled:cursor-not-allowed disabled:opacity-50"
          >
            拿不定主意？交给神谕来选
          </button>
          <button type="button" onClick={() => actions.discard(id)} className="text-ink-muted hover:text-ink">
            放弃这次
          </button>
        </div>
      </Section>
    );
  }

  return (
    <Section>
      <p className="text-center text-sm leading-relaxed text-ink-soft">
        {spread.positions.map((p) => p.nameCn).join(' · ')}
      </p>
      <div className="mt-6">
        <CardDeck
          positions={spread.positions}
          onComplete={(cards) => actions.completeDraw(id, cards)}
          onQuickDraw={mode === 'oracle' && canUseApi ? () => actions.quickDraw(id) : undefined}
          disabled={isBusy}
        />
      </div>
      <div className="mt-6 flex justify-center gap-5 text-sm">
        {mode === 'self' && (
          <button type="button" onClick={() => actions.backToSpreadChoice(id)} className="link">
            换个牌阵
          </button>
        )}
        <button type="button" onClick={() => actions.discard(id)} className="text-ink-muted hover:text-ink">
          放弃这次
        </button>
      </div>
    </Section>
  );
}

/* ─── 追问 ─── */

interface FollowUpSectionProps {
  agent: AgentMessage;
  followUp: FollowUpMessage;
  isBusy: boolean;
  canUseApi: boolean;
  actions: OracleLetterActions;
}

function FollowUpSection({
  agent,
  followUp: fu,
  isBusy,
  canUseApi,
  actions,
}: FollowUpSectionProps): ReactElement {
  const isRitual = fu.status === 'ritual';
  const isRevealRitual = isRitual && fu.ritualStage === 'reveal' && fu.additionalCards.length > 0;
  const allRevealed = fu.additionalCards.length > 0 && fu.revealedCount >= fu.additionalCards.length;
  const canRegenerate = !isBusy && canUseApi && (fu.status === 'done' || fu.status === 'error');
  const revealed = useStaggeredReveal(fu.additionalCards.length);

  const boardRevealedCount = isRitual
    ? fu.revealedCount
    : fu.revealedCount >= fu.additionalCards.length
      ? fu.additionalCards.length
      : revealed;

  // 追问的回复里常会回头提到首轮的牌
  const mentionCards = useMemo(
    () => [...agent.drawnCards, ...fu.additionalCards],
    [agent.drawnCards, fu.additionalCards],
  );

  const excludeCardIds = useMemo(() => {
    const ids = agent.drawnCards.map((d) => d.card.id);
    for (const other of agent.followUps) {
      if (other.id === fu.id) continue;
      for (const d of other.additionalCards) {
        ids.push(d.card.id);
      }
    }
    return ids;
  }, [agent.drawnCards, agent.followUps, fu.id]);

  const supplementaryPositions = useMemo(
    () =>
      isRitual && fu.ritualStage === 'shuffle' && fu.drawCount > 0
        ? makeSupplementaryPositions(fu.drawCount, 0)
        : [],
    [isRitual, fu.ritualStage, fu.drawCount],
  );

  return (
    <Section className="pb-7 md:pb-8">
      <div id={`fu-${fu.id}`} className="flex scroll-mt-28 items-start gap-3">
        <span className="voice-label mt-0.5">追问</span>
        <p className="whitespace-pre-wrap font-hand text-lg leading-relaxed text-voice">{fu.question}</p>
      </div>

      {fu.decision === 'draw' && (fu.reason || isRitual) && (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
          补抽 {fu.drawCount} 张{fu.reason ? ` · ${fu.reason}` : ''}
        </p>
      )}

      {isRitual && fu.ritualStage === 'shuffle' && supplementaryPositions.length > 0 && (
        <div className="mt-6">
          <CardDeck
            compact
            positions={supplementaryPositions}
            excludeCardIds={excludeCardIds}
            onComplete={(cards) => actions.completeFollowUpDraw(agent.id, fu.id, cards)}
            onQuickDraw={canUseApi ? () => actions.quickDrawFollowUp(agent.id, fu.id) : undefined}
            disabled={isBusy}
          />
          <div className="mt-4 flex justify-center text-sm">
            <button
              type="button"
              onClick={() => actions.discardFollowUp(agent.id, fu.id)}
              className="text-ink-muted hover:text-ink"
            >
              放弃这次追问
            </button>
          </div>
        </div>
      )}

      {fu.additionalCards.length > 0 && (
        <div className="mt-5">
          {isRevealRitual && (
            <p className="mb-4 text-center text-sm text-ink-soft">
              {allRevealed
                ? '补充牌都翻开了。'
                : `点按翻开补充牌，还剩 ${fu.additionalCards.length - fu.revealedCount} 张。`}
            </p>
          )}
          <SpreadBoard
            spreadId="supplementary"
            drawnCards={fu.additionalCards}
            revealedCount={boardRevealedCount}
            onRevealNext={
              isRevealRitual && !allRevealed
                ? () => actions.revealFollowUp(agent.id, fu.id)
                : undefined
            }
            size="xs"
          />
          {isRevealRitual && (
            <>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                {!allRevealed ? (
                  <button
                    type="button"
                    onClick={() => actions.revealFollowUp(agent.id, fu.id, true)}
                    className="btn btn-secondary h-10 px-5 text-sm"
                  >
                    全部翻开
                  </button>
                ) : canUseApi ? (
                  <button
                    type="button"
                    onClick={() => actions.interpretFollowUp(agent.id, fu.id)}
                    disabled={isBusy}
                    className="btn btn-primary h-10 px-6 text-sm"
                  >
                    请神谕解读
                  </button>
                ) : (
                  <>
                    <button type="button" onClick={actions.openSettings} className="btn btn-primary h-10 px-6 text-sm">
                      先配置 API
                    </button>
                    <p className="w-full text-center text-[13px] text-ink-muted">
                      解读需要连接模型，配置后回到这里继续。
                    </p>
                  </>
                )}
              </div>
              <div className="mt-3 flex justify-center text-sm">
                <button
                  type="button"
                  onClick={() => actions.discardFollowUp(agent.id, fu.id)}
                  className="text-ink-muted hover:text-ink"
                >
                  放弃这次追问
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {!isRitual && (fu.interpretation || fu.status === 'running' || fu.error) && (
        <div className="mt-5">
          <Interpretation
            content={fu.interpretation}
            isLoading={fu.status === 'running'}
            error={fu.error}
            notice={fu.notice}
            retry={fu.retry}
            drawnCards={mentionCards}
            signed={false}
          />
        </div>
      )}

      {canRegenerate && (
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => actions.regenerateFollowUp(agent.id, fu.id)}
            className="btn btn-ghost h-9 text-sm"
          >
            重新生成
          </button>
        </div>
      )}
    </Section>
  );
}
