'use client';

/**
 * Agent 对话状态管理
 *
 * 以「消息列表」为核心：用户消息 + Agent 消息（内嵌牌阵/牌面/解读）。
 * 一个 Agent 消息即一个完整回合，有两种选牌方式：
 * - 神谕选牌（oracle）：神谕选牌阵 → 用户亲手洗牌/挑牌/翻牌（或「替我抽」快捷跳过）→ 翻完自动流式解读；
 * - 亲手抽牌（self）：用户选阵、洗牌挑牌、逐张翻牌，翻完后点击请神谕解读。
 * 追问作为后续 Agent 消息追加，需要补牌时同样支持亲手抽牌或快捷跳过。
 */

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { ApiConfig, DrawnCard, FollowUp, Spread } from '@/lib/tarot/types';
import { drawCardsForSpread, drawSupplementaryCards } from '@/lib/tarot/draw';
import { loadChat, saveChat, clearChat } from '@/lib/agentChatStorage';
import {
  saveReading,
  updateReadingFollowUps,
  updateReadingInterpretation,
} from '@/lib/readingStorage';
import {
  chooseSpreadForQuestion,
  decideFollowUp,
  rerunAgentInterpretation,
  rerunFollowUpInterpretation,
  streamFollowUpInterpretation,
} from '@/lib/agent/agentTurn';
import { LLMError, classifyError } from '@/lib/api/errors';
import type { RetryState } from '@/lib/api/stream-client';
import { genId } from '@/lib/id';

// ─── 消息模型 ───────────────────────────────────────────────

/** 一次生成的状态 */
export type TurnStatus = 'running' | 'done' | 'error';

/** 首轮回合状态：ritual 表示抽牌进行中，之后同样进入 running → done / error */
export type AgentMessageStatus = 'ritual' | TurnStatus;

/** 选牌方式：oracle = 神谕选阵后用户抽牌（可替我抽）；self = 用户亲手选阵、洗牌、翻牌 */
export type DrawMode = 'oracle' | 'self';

/** 亲手抽牌的步骤 */
export type RitualStage = 'spread' | 'shuffle' | 'reveal';

/** 追问补牌的步骤 */
export type FollowUpRitualStage = 'shuffle' | 'reveal';

/** 追问消息状态 */
export type FollowUpMessageStatus = 'ritual' | TurnStatus;

/** 用户消息 */
export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
}

/** 首轮 Agent 回合消息（含牌阵与牌面） */
export interface AgentMessage {
  id: string;
  role: 'agent';
  content: string;
  status: AgentMessageStatus;
  error: string | null;
  mode: DrawMode;
  /** 抽牌仪式当前所在步骤；只在 status 为 ritual 时有值 */
  ritualStage: RitualStage | null;
  /** 按阵位顺序已翻开的张数 */
  revealedCount: number;
  /** 选定的牌阵与理由 */
  spread: Spread | null;
  spreadReason: string;
  /** 抽到的牌 */
  drawnCards: DrawnCard[];
  /** 非致命提示（如输出被截断） */
  notice: string | null;
  /** 关联的 Reading id，用于持久化 */
  readingId: string | null;
  /** 自动重试的瞬时状态（连接中断重试时非空） */
  retry: RetryState | null;
  /** 追问列表 */
  followUps: FollowUpMessage[];
}

/** 追问消息（嵌套在 Agent 首轮消息的 followUps 中） */
export interface FollowUpMessage {
  id: string;
  question: string;
  status: FollowUpMessageStatus;
  /** 追问补牌当前所在步骤；只在 status 为 ritual 时有值 */
  ritualStage: FollowUpRitualStage | null;
  /** 追问补牌已翻开的张数 */
  revealedCount: number;
  decision: 'direct' | 'draw' | null;
  drawCount: number;
  reason: string;
  additionalCards: DrawnCard[];
  interpretation: string;
  error: string | null;
  notice: string | null;
  /** 自动重试的瞬时状态 */
  retry: RetryState | null;
}

export type ChatMessage = UserMessage | AgentMessage;

// ─── 工厂 ───────────────────────────────────────────────────

function makeUserMessage(content: string): UserMessage {
  return { id: genId(), role: 'user', content };
}

function makeAgentMessage(mode: DrawMode = 'oracle'): AgentMessage {
  return {
    id: genId(),
    role: 'agent',
    content: '',
    status: mode === 'self' ? 'ritual' : 'running',
    error: null,
    mode,
    ritualStage: mode === 'self' ? 'spread' : null,
    revealedCount: 0,
    spread: null,
    spreadReason: '',
    drawnCards: [],
    notice: null,
    readingId: null,
    retry: null,
    followUps: [],
  };
}

function makeFollowUpMessage(question: string): FollowUpMessage {
  return {
    id: genId(),
    question,
    status: 'running',
    ritualStage: null,
    revealedCount: 0,
    decision: null,
    drawCount: 0,
    reason: '',
    additionalCards: [],
    interpretation: '',
    error: null,
    notice: null,
    retry: null,
  };
}

// ─── 错误消息提取 ────────────────────────────────────────────

function getErrorMessage(err: unknown): string {
  if (err instanceof LLMError) return err.info.message;
  return classifyError(err).message;
}

function toStoredFollowUps(agent: AgentMessage): FollowUp[] {
  return agent.followUps
    .filter((fu) => fu.status === 'done')
    .map((fu) => ({
      id: fu.id,
      question: fu.question,
      status: 'done' as const,
      decision: fu.decision ?? undefined,
      drawCount: fu.drawCount,
      reason: fu.reason,
      additionalCards: fu.additionalCards,
      revealedCount: fu.additionalCards.length,
      interpretation: fu.interpretation,
      error: fu.error,
    }));
}

// ─── 消息 store ─────────────────────────────────────────────
/** 与 useApiConfig 同样的模块级 store：对外是同一份消息，
 *  异步流程随时能读到最新值，无需再维护一份 ref 镜像。 */

interface MessageSnapshot {
  messages: ChatMessage[];
  /** 是否已尝试从 localStorage 恢复 */
  hydrated: boolean;
}

let snapshot: MessageSnapshot = { messages: [], hydrated: false };
const listeners = new Set<() => void>();
let storageRead = false;

function publish(next: MessageSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** 首次订阅时读取本地记录；同一页面生命周期只读一次 */
function hydrate(): void {
  if (storageRead || typeof window === 'undefined') return;
  storageRead = true;
  publish({ messages: loadChat(), hydrated: true });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  hydrate();
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): MessageSnapshot => snapshot;
const SERVER_SNAPSHOT: MessageSnapshot = { messages: [], hydrated: false };
const getServerSnapshot = (): MessageSnapshot => SERVER_SNAPSHOT;

/** 写入新消息列表并广播 */
function updateMessages(updater: (prev: ChatMessage[]) => ChatMessage[]): void {
  publish({ messages: updater(snapshot.messages), hydrated: true });
}

function findAgentMessage(agentId: string): AgentMessage | undefined {
  const found = snapshot.messages.find((m) => m.role === 'agent' && m.id === agentId);
  return found?.role === 'agent' ? found : undefined;
}

function findFollowUpMessage(
  agentId: string,
  followUpId: string,
): { agent: AgentMessage; followUp: FollowUpMessage } | undefined {
  const agent = findAgentMessage(agentId);
  if (!agent) return undefined;
  const followUp = agent.followUps.find((fu) => fu.id === followUpId);
  return followUp ? { agent, followUp } : undefined;
}

function collectExcludedCardIds(agent: AgentMessage, excludeFollowUpId?: string): string[] {
  const ids = agent.drawnCards.map((d) => d.card.id);
  for (const fu of agent.followUps) {
    if (fu.id === excludeFollowUpId) continue;
    for (const d of fu.additionalCards) {
      ids.push(d.card.id);
    }
  }
  return ids;
}

// ─── Hook ───────────────────────────────────────────────────

export function useAgentChat() {
  const { messages, hydrated: isHydrated } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const [isRunning, setIsRunning] = useState(false);

  /** 统一的 messages 提交函数 */
  const commit = useCallback(
    (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      updateMessages(updater);
    },
    [],
  );

  // 消息变化后落盘。流式输出期间 messages 每个 token 都变，
  // 直接写 localStorage 会成为热点，因此做 400ms 防抖；
  // 页面中途关闭时最多丢失最后 400ms 的内容。
  useEffect(() => {
    if (!isHydrated) return;
    const timer = window.setTimeout(() => saveChat(messages), 400);
    return () => window.clearTimeout(timer);
  }, [messages, isHydrated]);

  // AbortController 管理
  const activeAbortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    if (activeAbortRef.current) {
      activeAbortRef.current.abort();
      activeAbortRef.current = null;
    }
  }, []);

  const createController = useCallback((): AbortController => {
    cancel();
    const controller = new AbortController();
    activeAbortRef.current = controller;
    return controller;
  }, [cancel]);

  // ── 局部更新工具 ───────────────────────────────────────

  const patchAgent = useCallback(
    (
      agentId: string,
      patch: Partial<AgentMessage> | ((prev: AgentMessage) => Partial<AgentMessage>),
    ) => {
      commit((prev) => {
        let changed = false;
        const next = prev.map((message) => {
          if (message.role !== 'agent' || message.id !== agentId) return message;
          changed = true;
          const p = typeof patch === 'function' ? patch(message) : patch;
          return { ...message, ...p };
        });

        return changed ? next : prev;
      });
    },
    [commit],
  );

  const patchFollowUp = useCallback(
    (
      followUpId: string,
      patch: Partial<FollowUpMessage> | ((prev: FollowUpMessage) => Partial<FollowUpMessage>),
    ) => {
      commit((prev) => {
        let changed = false;
        const next = prev.map((message) => {
          if (
            message.role !== 'agent' ||
            !message.followUps.some((fu) => fu.id === followUpId)
          ) {
            return message;
          }

          changed = true;
          return {
            ...message,
            followUps: message.followUps.map((fu) => {
              if (fu.id !== followUpId) return fu;
              const p = typeof patch === 'function' ? patch(fu) : patch;
              return { ...fu, ...p };
            }),
          };
        });

        return changed ? next : prev;
      });
    },
    [commit],
  );

  const findOriginalQuestion = useCallback((agentId: string): string => {
    const current = snapshot.messages;
    const agentIndex = current.findIndex(
      (message) => message.role === 'agent' && message.id === agentId,
    );

    for (let i = agentIndex - 1; i >= 0; i--) {
      const message = current[i];
      if (message.role === 'user') return message.content;
    }

    return '';
  }, []);

  const persistFollowUpsForAgent = useCallback((agentId: string): void => {
    queueMicrotask(() => {
      const agent = findAgentMessage(agentId);
      if (!agent || !agent.readingId) return;
      updateReadingFollowUps(agent.readingId, toStoredFollowUps(agent));
    });
  }, []);

  // ── 共享流式执行工具 ───────────────────────────────────

  const runSpreadChoiceStep = useCallback(
    async (agentId: string, question: string, apiConfig: ApiConfig): Promise<void> => {
      patchAgent(agentId, {
        mode: 'oracle',
        status: 'running',
        ritualStage: null,
        spread: null,
        spreadReason: '',
        drawnCards: [],
        revealedCount: 0,
        content: '',
        error: null,
        notice: null,
        retry: null,
        readingId: null,
      });
      setIsRunning(true);
      const controller = createController();

      try {
        const { spread, reason } = await chooseSpreadForQuestion(
          question,
          apiConfig,
          controller.signal,
        );
        patchAgent(agentId, {
          spread,
          spreadReason: reason,
          status: 'ritual',
          ritualStage: 'shuffle',
          retry: null,
        });
      } catch (err) {
        if (err instanceof LLMError && err.info.code === 'ABORTED') {
          patchAgent(agentId, { status: 'error', error: '已停止生成', retry: null });
          return;
        }
        patchAgent(agentId, { status: 'error', error: getErrorMessage(err), retry: null });
      } finally {
        setIsRunning(false);
        if (activeAbortRef.current === controller) {
          activeAbortRef.current = null;
        }
      }
    },
    [createController, patchAgent],
  );

  const runAgentInterpretationStream = useCallback(
    async (
      agentId: string,
      question: string,
      spread: Spread,
      drawnCards: DrawnCard[],
      apiConfig: ApiConfig,
      options?: {
        previousInterpretation?: string;
        existingReadingId?: string | null;
        revealedCount?: number;
        extraInitialPatch?: Partial<AgentMessage>;
      },
    ): Promise<void> => {
      patchAgent(agentId, {
        status: 'running',
        ritualStage: null,
        content: '',
        error: null,
        notice: null,
        retry: null,
        ...options?.extraInitialPatch,
        ...(options?.revealedCount !== undefined
          ? { revealedCount: options.revealedCount }
          : {}),
      });
      setIsRunning(true);
      const controller = createController();

      try {
        const result = await rerunAgentInterpretation({
          question,
          spread,
          drawnCards,
          previousInterpretation: options?.previousInterpretation,
          apiConfig,
          signal: controller.signal,
          callbacks: {
            onContent: (chunk) =>
              patchAgent(agentId, (prev) => ({ content: prev.content + chunk })),
            onThinking: (chunk) =>
              patchAgent(agentId, (prev) => ({ content: prev.content + chunk })),
            onStreamError: (msg) =>
              patchAgent(agentId, (prev) => ({ error: prev.error ?? msg })),
            onRetry: (attempt, max) =>
              patchAgent(agentId, { retry: { attempt, max } }),
          },
        });

        const notice = result.truncated
          ? '解读内容因模型输出长度限制被截断，已显示部分内容。'
          : null;

        if (options?.existingReadingId) {
          updateReadingInterpretation(options.existingReadingId, result.interpretation);
          patchAgent(agentId, { status: 'done', notice });
        } else {
          const readingId = genId();
          saveReading({
            id: readingId,
            question,
            spread,
            drawnCards,
            interpretation: result.interpretation,
            createdAt: new Date(),
          });
          patchAgent(agentId, { status: 'done', readingId, notice });
        }
      } catch (err) {
        if (err instanceof LLMError && err.info.code === 'ABORTED') {
          patchAgent(agentId, { status: 'error', error: '已停止生成' });
          return;
        }
        patchAgent(agentId, { status: 'error', error: getErrorMessage(err) });
      } finally {
        patchAgent(agentId, { retry: null });
        setIsRunning(false);
        if (activeAbortRef.current === controller) {
          activeAbortRef.current = null;
        }
      }
    },
    [createController, patchAgent],
  );

  const runFollowUpInterpretationStream = useCallback(
    async (
      agentId: string,
      followUpId: string,
      apiConfig: ApiConfig,
      options?: {
        isRegenerate?: boolean;
        revealedCount?: number;
        extraInitialPatch?: Partial<FollowUpMessage>;
      },
    ): Promise<void> => {
      const found = findFollowUpMessage(agentId, followUpId);
      const originalQuestion = findOriginalQuestion(agentId);
      if (!found || !originalQuestion) return;

      const { agent, followUp } = found;
      if (!agent.spread || !agent.content) return;
      const spread = agent.spread;
      const previousInterpretation = agent.content;
      const decision = followUp.decision ?? 'direct';
      const additionalCards =
        options?.extraInitialPatch?.additionalCards ?? followUp.additionalCards;
      const previousFollowUpInterpretation = followUp.interpretation;

      patchFollowUp(followUpId, {
        status: 'running',
        ritualStage: null,
        error: null,
        notice: null,
        retry: null,
        interpretation: '',
        ...options?.extraInitialPatch,
        ...(options?.revealedCount !== undefined
          ? { revealedCount: options.revealedCount }
          : {}),
      });
      setIsRunning(true);
      const controller = createController();

      try {
        const streamCallbacks = {
          onContent: (chunk: string) =>
            patchFollowUp(followUpId, (prev) => ({
              interpretation: prev.interpretation + chunk,
            })),
          onThinking: (chunk: string) =>
            patchFollowUp(followUpId, (prev) => ({
              interpretation: prev.interpretation + chunk,
            })),
          onStreamError: (msg: string) =>
            patchFollowUp(followUpId, (prev) => ({ error: prev.error ?? msg })),
          onRetry: (attempt: number, max: number) =>
            patchFollowUp(followUpId, { retry: { attempt, max } }),
        };

        const result = options?.isRegenerate
          ? await rerunFollowUpInterpretation({
              originalQuestion,
              spread,
              drawnCards: agent.drawnCards,
              previousInterpretation,
              followUpQuestion: followUp.question,
              decision,
              additionalCards,
              previousFollowUpInterpretation,
              apiConfig,
              signal: controller.signal,
              callbacks: streamCallbacks,
            })
          : await streamFollowUpInterpretation({
              originalQuestion,
              spread,
              drawnCards: agent.drawnCards,
              previousInterpretation,
              followUpQuestion: followUp.question,
              decision,
              additionalCards,
              apiConfig,
              signal: controller.signal,
              callbacks: streamCallbacks,
            });

        patchFollowUp(followUpId, {
          status: 'done',
          notice: result.truncated ? '回复因输出长度限制被截断。' : null,
        });
        persistFollowUpsForAgent(agentId);
      } catch (err) {
        if (err instanceof LLMError && err.info.code === 'ABORTED') {
          patchFollowUp(followUpId, { status: 'error', error: '已停止生成' });
          return;
        }
        patchFollowUp(followUpId, { status: 'error', error: getErrorMessage(err) });
      } finally {
        patchFollowUp(followUpId, { retry: null });
        setIsRunning(false);
        if (activeAbortRef.current === controller) {
          activeAbortRef.current = null;
        }
      }
    },
    [createController, findOriginalQuestion, patchFollowUp, persistFollowUpsForAgent],
  );

  const runFollowUpDecideAndMaybeStream = useCallback(
    async (
      agentId: string,
      followUpId: string,
      followUpQuestion: string,
      apiConfig: ApiConfig,
    ): Promise<void> => {
      const agent = findAgentMessage(agentId);
      const originalQuestion = findOriginalQuestion(agentId);
      if (!agent || !agent.spread || !agent.content || !originalQuestion) return;

      setIsRunning(true);
      const controller = createController();

      try {
        const { decision, drawCount, reason } = await decideFollowUp({
          originalQuestion,
          spread: agent.spread,
          drawnCards: agent.drawnCards,
          previousInterpretation: agent.content,
          followUpQuestion,
          apiConfig,
          signal: controller.signal,
        });

        patchFollowUp(followUpId, { decision, drawCount, reason });

        if (decision === 'draw' && drawCount > 0) {
          patchFollowUp(followUpId, {
            status: 'ritual',
            ritualStage: 'shuffle',
            revealedCount: 0,
            retry: null,
          });
          return;
        }

        const result = await streamFollowUpInterpretation({
          originalQuestion,
          spread: agent.spread,
          drawnCards: agent.drawnCards,
          previousInterpretation: agent.content,
          followUpQuestion,
          decision,
          additionalCards: [],
          apiConfig,
          signal: controller.signal,
          callbacks: {
            onContent: (chunk) =>
              patchFollowUp(followUpId, (prev) => ({
                interpretation: prev.interpretation + chunk,
              })),
            onThinking: (chunk) =>
              patchFollowUp(followUpId, (prev) => ({
                interpretation: prev.interpretation + chunk,
              })),
            onStreamError: (msg) =>
              patchFollowUp(followUpId, (prev) => ({ error: prev.error ?? msg })),
            onRetry: (attempt, max) =>
              patchFollowUp(followUpId, { retry: { attempt, max } }),
          },
        });

        patchFollowUp(followUpId, {
          status: 'done',
          notice: result.truncated ? '回复因输出长度限制被截断。' : null,
        });
        persistFollowUpsForAgent(agentId);
      } catch (err) {
        if (err instanceof LLMError && err.info.code === 'ABORTED') {
          patchFollowUp(followUpId, { status: 'error', error: '已停止生成' });
          return;
        }
        patchFollowUp(followUpId, { status: 'error', error: getErrorMessage(err) });
      } finally {
        patchFollowUp(followUpId, { retry: null });
        setIsRunning(false);
        if (activeAbortRef.current === controller) {
          activeAbortRef.current = null;
        }
      }
    },
    [createController, findOriginalQuestion, patchFollowUp, persistFollowUpsForAgent],
  );

  // ── 发起首轮提问（神谕选阵后交由用户抽牌） ──────────────

  const sendQuestion = useCallback(
    async (question: string, apiConfig: ApiConfig): Promise<void> => {
      const trimmed = question.trim();
      if (!trimmed || isRunning) return;

      const userMsg = makeUserMessage(trimmed);
      const agentMsg = makeAgentMessage('oracle');
      commit((prev) => [...prev, userMsg, agentMsg]);

      await runSpreadChoiceStep(agentMsg.id, trimmed, apiConfig);
    },
    [isRunning, commit, runSpreadChoiceStep],
  );

  // ── 发起追问 ───────────────────────────────────────────

  const askFollowUp = useCallback(
    async (question: string, apiConfig: ApiConfig): Promise<void> => {
      const trimmed = question.trim();
      if (!trimmed || isRunning) return;

      // 找到最后一个 agent 消息作为追问的上下文
      const lastAgent = [...snapshot.messages].reverse().find((m) => m.role === 'agent');
      if (
        !lastAgent ||
        lastAgent.role !== 'agent' ||
        lastAgent.status !== 'done' ||
        !lastAgent.spread ||
        !lastAgent.content ||
        lastAgent.followUps.some((fu) => fu.status === 'ritual' || fu.status === 'running')
      ) {
        return;
      }

      const followUp = makeFollowUpMessage(trimmed);
      const targetAgentId = lastAgent.id;

      commit((prev) => {
        let changed = false;
        const next = prev.map((message) => {
          if (message.role !== 'agent' || message.id !== targetAgentId) {
            return message;
          }

          changed = true;
          return { ...message, followUps: [...message.followUps, followUp] };
        });

        return changed ? next : prev;
      });

      await runFollowUpDecideAndMaybeStream(targetAgentId, followUp.id, trimmed, apiConfig);
    },
    [isRunning, commit, runFollowUpDecideAndMaybeStream],
  );

  // ── 重新生成首轮回复 ─────────────────────────────────────

  const regenerateAgentMessage = useCallback(
    async (agentId: string, apiConfig: ApiConfig): Promise<void> => {
      if (isRunning) return;

      const target = findAgentMessage(agentId);
      if (!target) return;

      const originalQuestion = findOriginalQuestion(agentId);
      if (!originalQuestion) return;

      if (target.spread && target.drawnCards.length > 0) {
        await runAgentInterpretationStream(
          agentId,
          originalQuestion,
          target.spread,
          target.drawnCards,
          apiConfig,
          {
            previousInterpretation: target.content,
            existingReadingId: target.readingId,
          },
        );
        return;
      }

      if (target.spread) {
        patchAgent(agentId, {
          status: 'ritual',
          ritualStage: 'shuffle',
          error: null,
          notice: null,
          retry: null,
        });
        return;
      }

      await runSpreadChoiceStep(agentId, originalQuestion, apiConfig);
    },
    [isRunning, findOriginalQuestion, patchAgent, runAgentInterpretationStream, runSpreadChoiceStep],
  );

  // ── 重新生成追问回复 ─────────────────────────────────────

  const regenerateFollowUp = useCallback(
    async (agentId: string, followUpId: string, apiConfig: ApiConfig): Promise<void> => {
      if (isRunning) return;

      const found = findFollowUpMessage(agentId, followUpId);
      const originalQuestion = findOriginalQuestion(agentId);
      if (!found || !found.agent.spread || !found.agent.content || !originalQuestion) {
        return;
      }

      const { followUp } = found;
      const canReuseDecision =
        followUp.decision !== null &&
        (followUp.decision === 'direct' || followUp.additionalCards.length > 0);

      if (canReuseDecision) {
        await runFollowUpInterpretationStream(agentId, followUpId, apiConfig, {
          isRegenerate: true,
        });
        return;
      }

      if (
        followUp.decision === 'draw' &&
        followUp.drawCount > 0 &&
        followUp.additionalCards.length === 0
      ) {
        patchFollowUp(followUpId, {
          status: 'ritual',
          ritualStage: 'shuffle',
          revealedCount: 0,
          error: null,
          notice: null,
          retry: null,
        });
        return;
      }

      patchFollowUp(followUpId, {
        status: 'running',
        ritualStage: null,
        revealedCount: 0,
        error: null,
        notice: null,
        retry: null,
        interpretation: '',
        decision: null,
        drawCount: 0,
        reason: '',
        additionalCards: [],
      });

      await runFollowUpDecideAndMaybeStream(agentId, followUpId, followUp.question, apiConfig);
    },
    [
      isRunning,
      findOriginalQuestion,
      patchFollowUp,
      runFollowUpInterpretationStream,
      runFollowUpDecideAndMaybeStream,
    ],
  );

  // ── 首轮抽牌仪式（self 与 oracle 共用） ──────────────────

  /** 记下问题并开始亲手抽牌；选阵、洗牌、翻牌都不需要 API */
  const startRitual = useCallback(
    (question: string): void => {
      const trimmed = question.trim();
      if (!trimmed || isRunning) return;
      commit((prev) => [...prev, makeUserMessage(trimmed), makeAgentMessage('self')]);
    },
    [isRunning, commit],
  );

  const chooseRitualSpread = useCallback(
    (agentId: string, spread: Spread): void => {
      patchAgent(agentId, (prev) =>
        prev.status === 'ritual' ? { spread, ritualStage: 'shuffle' } : {},
      );
    },
    [patchAgent],
  );

  const backToSpreadChoice = useCallback(
    (agentId: string): void => {
      patchAgent(agentId, (prev) =>
        prev.status === 'ritual' && prev.ritualStage === 'shuffle' ? { ritualStage: 'spread' } : {},
      );
    },
    [patchAgent],
  );

  /** 牌全部翻开后请神谕解读，完成后存入手札 */
  const interpretRitual = useCallback(
    async (agentId: string, apiConfig: ApiConfig): Promise<void> => {
      if (isRunning) return;

      const target = findAgentMessage(agentId);
      if (
        !target ||
        target.status !== 'ritual' ||
        !target.spread ||
        target.drawnCards.length === 0 ||
        target.revealedCount < target.drawnCards.length
      ) {
        return;
      }

      const question = findOriginalQuestion(agentId);
      if (!question) return;

      await runAgentInterpretationStream(
        agentId,
        question,
        target.spread,
        target.drawnCards,
        apiConfig,
      );
    },
    [isRunning, findOriginalQuestion, runAgentInterpretationStream],
  );

  /** 用户洗牌并挑牌完成后落入阵位（牌已在槽中显形）；神谕模式自动开始解读 */
  const completeRitualDraw = useCallback(
    (agentId: string, drawnCards: DrawnCard[], autoInterpretConfig?: ApiConfig): void => {
      const target = findAgentMessage(agentId);
      if (!target || target.status !== 'ritual' || !target.spread) return;
      if (drawnCards.length !== target.spread.positions.length) return;
      patchAgent(agentId, {
        drawnCards,
        revealedCount: drawnCards.length,
        ritualStage: 'reveal',
      });

      if (target.mode === 'oracle' && autoInterpretConfig) {
        void interpretRitual(agentId, autoInterpretConfig);
      }
    },
    [patchAgent, interpretRitual],
  );

  /** 神谕模式快捷跳过：替用户抽牌并直接开始流式解读 */
  const quickDrawOracle = useCallback(
    async (agentId: string, apiConfig: ApiConfig): Promise<void> => {
      if (isRunning) return;

      const target = findAgentMessage(agentId);
      if (
        !target ||
        target.status !== 'ritual' ||
        !target.spread ||
        target.drawnCards.length > 0
      ) {
        return;
      }

      const question = findOriginalQuestion(agentId);
      if (!question) return;

      const drawnCards = drawCardsForSpread(target.spread);
      await runAgentInterpretationStream(
        agentId,
        question,
        target.spread,
        drawnCards,
        apiConfig,
        {
          revealedCount: 0,
          extraInitialPatch: { drawnCards },
        },
      );
    },
    [isRunning, findOriginalQuestion, runAgentInterpretationStream],
  );

  /** 按阵位顺序翻开下一张；all 为 true 时全部翻开；神谕模式翻完最后一张自动开始解读 */
  const revealCards = useCallback(
    (agentId: string, all = false, autoInterpretConfig?: ApiConfig): void => {
      const target = findAgentMessage(agentId);
      if (!target || target.status !== 'ritual' || target.ritualStage !== 'reveal') return;
      const total = target.drawnCards.length;
      const nextCount = all ? total : Math.min(total, target.revealedCount + 1);
      patchAgent(agentId, { revealedCount: nextCount });

      if (target.mode === 'oracle' && nextCount >= total && autoInterpretConfig) {
        void interpretRitual(agentId, autoInterpretConfig);
      }
    },
    [patchAgent, interpretRitual],
  );

  /** 还没抽牌时改主意：由神谕挑选牌阵，再停下来由用户亲手抽牌 */
  const handOverToOracle = useCallback(
    async (agentId: string, apiConfig: ApiConfig): Promise<void> => {
      const target = findAgentMessage(agentId);
      if (isRunning || !target || target.status !== 'ritual' || target.drawnCards.length > 0) {
        return;
      }
      const question = findOriginalQuestion(agentId);
      if (!question) return;
      await runSpreadChoiceStep(agentId, question, apiConfig);
    },
    [isRunning, findOriginalQuestion, runSpreadChoiceStep],
  );

  /** 放弃这次亲手抽牌，连同它的问题一起移除 */
  const discardRitual = useCallback(
    (agentId: string): void => {
      commit((prev) => {
        const index = prev.findIndex((m) => m.role === 'agent' && m.id === agentId);
        const target = prev[index];
        if (!target || target.role !== 'agent' || target.status !== 'ritual') return prev;
        const start = prev[index - 1]?.role === 'user' ? index - 1 : index;
        return [...prev.slice(0, start), ...prev.slice(index + 1)];
      });
    },
    [commit],
  );

  // ── 追问补牌仪式 ───────────────────────────────────────

  const interpretFollowUp = useCallback(
    async (agentId: string, followUpId: string, apiConfig: ApiConfig): Promise<void> => {
      if (isRunning) return;
      const found = findFollowUpMessage(agentId, followUpId);
      if (!found) return;
      const { followUp } = found;
      if (
        followUp.status !== 'ritual' ||
        followUp.additionalCards.length === 0 ||
        followUp.revealedCount < followUp.additionalCards.length
      ) {
        return;
      }
      await runFollowUpInterpretationStream(agentId, followUpId, apiConfig, {
        isRegenerate: false,
      });
    },
    [isRunning, runFollowUpInterpretationStream],
  );

  const completeFollowUpDraw = useCallback(
    (
      agentId: string,
      followUpId: string,
      cards: DrawnCard[],
      autoInterpretConfig?: ApiConfig,
    ): void => {
      const found = findFollowUpMessage(agentId, followUpId);
      if (!found) return;
      const { followUp } = found;
      if (
        followUp.status !== 'ritual' ||
        followUp.decision !== 'draw' ||
        cards.length !== followUp.drawCount
      ) {
        return;
      }
      patchFollowUp(followUpId, {
        additionalCards: cards,
        revealedCount: cards.length,
        ritualStage: 'reveal',
      });

      if (autoInterpretConfig) {
        void interpretFollowUp(agentId, followUpId, autoInterpretConfig);
      }
    },
    [patchFollowUp, interpretFollowUp],
  );

  const quickDrawFollowUp = useCallback(
    async (agentId: string, followUpId: string, apiConfig: ApiConfig): Promise<void> => {
      if (isRunning) return;
      const found = findFollowUpMessage(agentId, followUpId);
      if (!found) return;
      const { agent, followUp } = found;
      if (
        followUp.status !== 'ritual' ||
        followUp.decision !== 'draw' ||
        followUp.drawCount <= 0 ||
        followUp.additionalCards.length > 0
      ) {
        return;
      }
      const excludeCardIds = collectExcludedCardIds(agent, followUpId);
      const additionalCards = drawSupplementaryCards(followUp.drawCount, 0, excludeCardIds);
      await runFollowUpInterpretationStream(agentId, followUpId, apiConfig, {
        isRegenerate: false,
        revealedCount: 0,
        extraInitialPatch: { additionalCards },
      });
    },
    [isRunning, runFollowUpInterpretationStream],
  );

  const revealFollowUpCards = useCallback(
    (
      agentId: string,
      followUpId: string,
      all = false,
      autoInterpretConfig?: ApiConfig,
    ): void => {
      const found = findFollowUpMessage(agentId, followUpId);
      if (!found) return;
      const { followUp } = found;
      if (followUp.status !== 'ritual' || followUp.ritualStage !== 'reveal') return;
      const total = followUp.additionalCards.length;
      const nextCount = all ? total : Math.min(total, followUp.revealedCount + 1);
      patchFollowUp(followUpId, { revealedCount: nextCount });

      if (nextCount >= total && autoInterpretConfig) {
        void interpretFollowUp(agentId, followUpId, autoInterpretConfig);
      }
    },
    [patchFollowUp, interpretFollowUp],
  );

  const discardFollowUp = useCallback(
    (agentId: string, followUpId: string): void => {
      commit((prev) =>
        prev.map((msg) => {
          if (msg.role !== 'agent' || msg.id !== agentId) return msg;
          const target = msg.followUps.find((fu) => fu.id === followUpId);
          if (!target || target.status !== 'ritual') return msg;
          return {
            ...msg,
            followUps: msg.followUps.filter((fu) => fu.id !== followUpId),
          };
        }),
      );
    },
    [commit],
  );

  // ── 重置 ───────────────────────────────────────────────

  const reset = useCallback(() => {
    cancel();
    commit(() => []);
    setIsRunning(false);
    clearChat();
  }, [cancel, commit]);

  return {
    messages,
    isHydrated,
    isRunning,
    sendQuestion,
    askFollowUp,
    regenerateAgentMessage,
    regenerateFollowUp,
    startRitual,
    chooseRitualSpread,
    backToSpreadChoice,
    completeRitualDraw,
    quickDrawOracle,
    revealCards,
    interpretRitual,
    handOverToOracle,
    discardRitual,
    completeFollowUpDraw,
    quickDrawFollowUp,
    revealFollowUpCards,
    interpretFollowUp,
    discardFollowUp,
    cancel,
    reset,
  };
}
