import { describe, it, expect, beforeEach, vi } from 'vitest';
import { saveChat, loadChat, clearChat } from '@/lib/agentChatStorage';
import { drawCardsForSpread, drawSupplementaryCards } from '@/lib/tarot/draw';
import { getSpreadById } from '@/lib/tarot/spreads';
import type { ChatMessage, AgentMessage, FollowUpMessage } from '@/hooks/useAgentChat';

const STORAGE_KEY = 'mystic-tarot-chat-v1';

function makeFollowUp(overrides: Partial<FollowUpMessage> = {}): FollowUpMessage {
  return {
    id: 'f1',
    question: '追问',
    status: 'done',
    ritualStage: null,
    revealedCount: 0,
    decision: 'direct',
    drawCount: 0,
    reason: '',
    additionalCards: [],
    interpretation: '追问回复',
    error: null,
    notice: null,
    retry: null,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'a1',
    role: 'agent',
    content: '解读内容',
    status: 'done',
    error: null,
    mode: 'oracle',
    ritualStage: null,
    revealedCount: 0,
    spread: null,
    spreadReason: '',
    drawnCards: [],
    notice: null,
    readingId: null,
    retry: null,
    followUps: [],
    ...overrides,
  };
}

describe('对话持久化', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('保存后能读回', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: '我的问题' },
      makeAgent(),
    ];
    saveChat(messages);

    const restored = loadChat();
    expect(restored).toHaveLength(2);
    expect(restored[0]).toMatchObject({ role: 'user', content: '我的问题' });
    expect(restored[1]).toMatchObject({ role: 'agent', content: '解读内容' });
  });

  it('保存空列表时清空存储', () => {
    saveChat([makeAgent()]);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    saveChat([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('刷新后仍在生成中的消息会被标为中断', () => {
    saveChat([makeAgent({ status: 'running', content: '' })]);

    const [restored] = loadChat();
    expect(restored.role).toBe('agent');
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.status).toBe('error');
    expect(restored.error).toContain('中断');
  });

  it('已产出正文的中断消息保留正文且不报错', () => {
    saveChat([makeAgent({ status: 'running', content: '已生成的部分' })]);

    const [restored] = loadChat();
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.status).toBe('error');
    expect(restored.content).toBe('已生成的部分');
    expect(restored.error).toBeNull();
  });

  it('亲手抽牌进行中的消息原样恢复，可以接着翻牌', () => {
    const spread = getSpreadById('three-card')!;
    const drawnCards = drawCardsForSpread(spread);
    saveChat([
      makeAgent({
        mode: 'self',
        status: 'ritual',
        ritualStage: 'reveal',
        content: '',
        spread,
        drawnCards,
        revealedCount: 2,
      }),
    ]);

    const [restored] = loadChat();
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.status).toBe('ritual');
    expect(restored.error).toBeNull();
    expect(restored.ritualStage).toBe('reveal');
    expect(restored.revealedCount).toBe(2);
  });

  it('亲手抽牌的步骤与已有数据不符时按数据纠正', () => {
    saveChat([
      makeAgent({ mode: 'self', status: 'ritual', ritualStage: 'reveal', content: '' }),
    ]);

    const [restored] = loadChat();
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.ritualStage).toBe('spread');
  });

  it('旧版本记录缺少选牌方式字段时补上默认值', () => {
    const legacy: Record<string, unknown> = { ...makeAgent() };
    delete legacy.mode;
    delete legacy.ritualStage;
    delete legacy.revealedCount;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([legacy]));

    const [restored] = loadChat();
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.mode).toBe('oracle');
    expect(restored.ritualStage).toBeNull();
    expect(restored.revealedCount).toBe(0);
  });

  it('瞬时重试状态不会被持久化', () => {
    saveChat([makeAgent({ retry: { attempt: 2, max: 3 } })]);

    const [restored] = loadChat();
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.retry).toBeNull();
  });

  it('追问的中断态同样被修正', () => {
    saveChat([
      makeAgent({
        followUps: [
          makeFollowUp({
            status: 'running',
            decision: null,
            interpretation: '',
            retry: { attempt: 1, max: 2 },
          }),
        ],
      }),
    ]);

    const [restored] = loadChat();
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.followUps[0].status).toBe('error');
    expect(restored.followUps[0].error).toContain('中断');
    expect(restored.followUps[0].retry).toBeNull();
  });

  it('神谕选好牌阵待用户抽牌的状态刷新后完整恢复', () => {
    const spread = getSpreadById('three-card')!;
    saveChat([
      makeAgent({
        mode: 'oracle',
        status: 'ritual',
        ritualStage: 'shuffle',
        spread,
        spreadReason: '为你展开三张牌阵',
        content: '',
        drawnCards: [],
      }),
    ]);

    const [restored] = loadChat();
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.mode).toBe('oracle');
    expect(restored.status).toBe('ritual');
    expect(restored.ritualStage).toBe('shuffle');
    expect(restored.spread?.id).toBe('three-card');
    expect(restored.error).toBeNull();
  });

  it('追问补牌进行中的状态刷新后完整恢复并保留已翻开张数', () => {
    const additionalCards = drawSupplementaryCards(2);
    saveChat([
      makeAgent({
        followUps: [
          makeFollowUp({
            id: 'f-shuffle',
            status: 'ritual',
            ritualStage: 'shuffle',
            decision: 'draw',
            drawCount: 2,
            additionalCards: [],
            revealedCount: 0,
            interpretation: '',
          }),
          makeFollowUp({
            id: 'f-reveal',
            status: 'ritual',
            ritualStage: 'reveal',
            decision: 'draw',
            drawCount: 2,
            additionalCards,
            revealedCount: 1,
            interpretation: '',
          }),
        ],
      }),
    ]);

    const [restored] = loadChat();
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.followUps[0]).toMatchObject({
      status: 'ritual',
      ritualStage: 'shuffle',
      revealedCount: 0,
    });
    expect(restored.followUps[1]).toMatchObject({
      status: 'ritual',
      ritualStage: 'reveal',
      revealedCount: 1,
    });
  });

  it('追问为 ritual 但缺少有效抽牌决策时安全降级为中断态', () => {
    saveChat([
      makeAgent({
        followUps: [
          makeFollowUp({
            status: 'ritual',
            ritualStage: 'shuffle',
            decision: 'direct',
            drawCount: 0,
            interpretation: '',
          }),
        ],
      }),
    ]);

    const [restored] = loadChat();
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.followUps[0].status).toBe('error');
    expect(restored.followUps[0].ritualStage).toBeNull();
    expect(restored.followUps[0].error).toContain('中断');
  });

  it('旧记录追问缺少 ritualStage 与 revealedCount 时补全默认值', () => {
    const additionalCards = drawSupplementaryCards(2);
    const legacyFollowUp: Record<string, unknown> = {
      ...makeFollowUp({ additionalCards }),
    };
    delete legacyFollowUp.ritualStage;
    delete legacyFollowUp.revealedCount;

    const legacyAgent: Record<string, unknown> = {
      ...makeAgent(),
      followUps: [legacyFollowUp],
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([legacyAgent]));

    const [restored] = loadChat();
    if (restored.role !== 'agent') throw new Error('expected agent message');
    expect(restored.followUps[0].ritualStage).toBeNull();
    expect(restored.followUps[0].revealedCount).toBe(2);
  });

  it('只保留最近的若干条消息', () => {
    const many: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({
      id: `u${i}`,
      role: 'user' as const,
      content: `问题 ${i}`,
    }));
    saveChat(many);

    const restored = loadChat();
    expect(restored).toHaveLength(60);
    expect(restored[restored.length - 1]).toMatchObject({ content: '问题 99' });
  });

  it('损坏的数据不会抛错', () => {
    // 该路径会打印错误日志，测试中静音以免污染输出
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    window.localStorage.setItem(STORAGE_KEY, '{ not json');
    expect(loadChat()).toEqual([]);

    window.localStorage.setItem(STORAGE_KEY, '"just a string"');
    expect(loadChat()).toEqual([]);

    spy.mockRestore();
  });

  it('结构不合法的消息被跳过', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: 'u1', role: 'user', content: '正常' },
        { id: 'bad', role: 'agent' }, // 缺少 followUps / drawnCards
        { nope: true },
      ]),
    );

    const restored = loadChat();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ content: '正常' });
  });

  it('clearChat 清空存储', () => {
    saveChat([makeAgent()]);
    clearChat();
    expect(loadChat()).toEqual([]);
  });
});
