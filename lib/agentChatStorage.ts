/**
 * 对话消息持久化
 *
 * 对话此前只存在内存里：刷新或关掉标签页就丢失，
 * 但每轮对话都已写入「轨迹」，造成主交互反而记不住上下文。
 *
 * 保存时剔除瞬时字段（重试状态）；恢复时把仍标记为 running 的消息
 * 视为「被中断」，否则刷新后会永远停在生成中。
 * 亲手抽牌（ritual）不涉及网络请求，原样恢复，用户可以接着翻牌。
 */

import type {
  AgentMessage,
  ChatMessage,
  FollowUpMessage,
  FollowUpRitualStage,
  RitualStage,
} from '@/hooks/useAgentChat';

const STORAGE_KEY = 'mystic-tarot-chat-v1';

/** 只保留最近若干条消息，避免 localStorage 无限增长 */
const MAX_MESSAGES = 60;

/** 恢复时给中断消息的提示 */
const INTERRUPTED_HINT = '上次生成被中断（页面已关闭或刷新），可重新提问或重新生成。';

/** 落盘前清掉不应持久化的瞬时字段 */
function toStored(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_MESSAGES).map((msg) => {
    if (msg.role === 'user') return msg;
    return {
      ...msg,
      retry: null,
      followUps: msg.followUps.map((fu) => ({ ...fu, retry: null })),
    };
  });
}

/** 亲手抽牌的步骤以已有数据为准，避免停在缺牌阵或缺牌的步骤上 */
function restoreRitualStage(msg: AgentMessage): RitualStage {
  if (!msg.spread) return 'spread';
  if (msg.drawnCards.length > 0) return 'reveal';
  return msg.ritualStage === 'spread' ? 'spread' : 'shuffle';
}

/** 追问补牌的步骤以已有数据为准 */
function restoreFollowUpRitualStage(fu: FollowUpMessage): FollowUpRitualStage {
  return Array.isArray(fu.additionalCards) && fu.additionalCards.length > 0
    ? 'reveal'
    : 'shuffle';
}

/** 补齐追问记录缺少的字段并处理中断状态 */
function normalizeFollowUp(raw: FollowUpMessage): FollowUpMessage {
  const additionalCards = Array.isArray(raw.additionalCards) ? raw.additionalCards : [];
  const revealedCount = Number.isInteger(raw.revealedCount)
    ? Math.min(Math.max(raw.revealedCount, 0), additionalCards.length)
    : raw.status === 'done'
      ? additionalCards.length
      : 0;

  const base: FollowUpMessage = {
    ...raw,
    additionalCards,
    revealedCount,
    ritualStage: null,
    retry: null,
  };

  if (raw.status === 'running') {
    return {
      ...base,
      status: 'error',
      error: raw.interpretation ? null : INTERRUPTED_HINT,
    };
  }

  if (raw.status === 'ritual') {
    if (raw.decision === 'draw' && raw.drawCount > 0) {
      return {
        ...base,
        status: 'ritual',
        ritualStage: restoreFollowUpRitualStage(base),
      };
    }
    return {
      ...base,
      status: 'error',
      error: INTERRUPTED_HINT,
    };
  }

  return base;
}

/** 补齐旧版本记录缺少的字段 */
function withDefaults(msg: AgentMessage): AgentMessage {
  const isRitual = msg.status === 'ritual';
  return {
    ...msg,
    mode: msg.mode === 'self' ? 'self' : 'oracle',
    ritualStage: isRitual ? restoreRitualStage(msg) : null,
    revealedCount: Number.isInteger(msg.revealedCount)
      ? Math.min(Math.max(msg.revealedCount, 0), msg.drawnCards.length)
      : 0,
    followUps: msg.followUps.map(normalizeFollowUp),
  };
}

/** 恢复时把进行中的状态改为中断态 */
function fromStored(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((raw) => {
    if (raw.role === 'user') return raw;
    const msg = withDefaults(raw);

    // 首轮消息：生成中被打断且正文为空，说明还没产出内容
    if (msg.status === 'running') {
      return {
        ...msg,
        status: 'error' as const,
        error: msg.content ? null : INTERRUPTED_HINT,
        retry: null,
      };
    }

    return { ...msg, retry: null };
  });
}

/** 粗略校验，避免损坏的数据让页面崩溃 */
function isMessageLike(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const msg = value as Record<string, unknown>;
  if (typeof msg.id !== 'string' || typeof msg.content !== 'string') return false;
  if (msg.role === 'user') return true;
  if (msg.role !== 'agent') return false;
  return Array.isArray(msg.followUps) && Array.isArray(msg.drawnCards);
}

export function saveChat(messages: ChatMessage[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (messages.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStored(messages)));
  } catch (error) {
    // 配额超限时不阻断对话，只丢弃这次持久化
    if (error instanceof Error && error.name === 'QuotaExceededError') {
      console.warn('对话记录过大，本次未保存');
    } else {
      console.error('Failed to save chat:', error);
    }
  }
}

export function loadChat(): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return fromStored(parsed.filter(isMessageLike));
  } catch (error) {
    console.error('Failed to load chat:', error);
    return [];
  }
}

export function clearChat(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear chat:', error);
  }
}
