import { describe, expect, it, vi } from 'vitest'
import { BlockedNotifier, RunEndNotifier } from '../src/notifier.js'
import type { SessionEvent } from '../src/types.js'

function turnEnd(kind: string): SessionEvent {
  return { type: 'turn/end', data: { reason: { kind } } }
}

describe('RunEndNotifier', () => {
  it('notifies once at idle with the latest turn/end kind', () => {
    const notify = vi.fn()
    const notifier = new RunEndNotifier({ notify })

    notifier.onSessionEvent('s1', turnEnd('completed'))
    notifier.onSessionEvent('s1', turnEnd('completed')) // 多轮目标运行
    notifier.onIdle('s1')

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('completed', 's1')
  })

  it('ignores idle when no turn ended in the activity', () => {
    const notify = vi.fn()
    const notifier = new RunEndNotifier({ notify })
    notifier.onIdle('s1')
    expect(notify).not.toHaveBeenCalled()
  })

  it('consumes the recorded reason — a second idle does not re-notify', () => {
    const notify = vi.fn()
    const notifier = new RunEndNotifier({ notify })
    notifier.onSessionEvent('s1', turnEnd('error'))
    notifier.onIdle('s1')
    notifier.onIdle('s1')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('tracks sessions independently', () => {
    const notify = vi.fn()
    const notifier = new RunEndNotifier({ notify })
    notifier.onSessionEvent('s1', turnEnd('completed'))
    notifier.onSessionEvent('s2', turnEnd('error'))
    notifier.onIdle('s1')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('completed', 's1')
    notifier.onIdle('s2')
    expect(notify).toHaveBeenCalledWith('error', 's2')
  })

  it('onRunStart clears a stale reason from the previous run', () => {
    const notify = vi.fn()
    const notifier = new RunEndNotifier({ notify })
    notifier.onSessionEvent('s1', turnEnd('error'))
    expect(notifier.hasReason('s1')).toBe(true)
    notifier.onRunStart('s1')
    expect(notifier.hasReason('s1')).toBe(false)
    notifier.onIdle('s1')
    expect(notify).not.toHaveBeenCalled()
  })

  it('ignores non-turn/end events and falls back to unknown for a missing kind', () => {
    const notify = vi.fn()
    const notifier = new RunEndNotifier({ notify })
    notifier.onSessionEvent('s1', { type: 'session/title', data: { title: 't' } })
    notifier.onSessionEvent('s1', { type: 'turn/end', data: {} })
    notifier.onIdle('s1')
    expect(notify).toHaveBeenCalledWith('unknown', 's1')
  })
})

describe('BlockedNotifier', () => {
  it('notifies immediately on ask_user_question with the extracted text', () => {
    const notify = vi.fn()
    const notifier = new BlockedNotifier({ notify })
    notifier.onSessionEvent('s1', {
      type: 'tool/call',
      data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: '选哪个方案？' }] }) },
    })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('question', '选哪个方案？', 's1')
  })

  it('ignores other tool calls', () => {
    const notify = vi.fn()
    const notifier = new BlockedNotifier({ notify })
    notifier.onSessionEvent('s1', { type: 'tool/call', data: { name: 'Bash', arguments: '{}' } })
    expect(notify).not.toHaveBeenCalled()
  })

  it('notifies on approval/asked with toolName — reason, tolerating a missing reason', () => {
    const notify = vi.fn()
    const notifier = new BlockedNotifier({ notify })
    notifier.onSessionEvent('s1', { type: 'approval/asked', data: { toolName: 'Bash', reason: '越权执行' } })
    notifier.onSessionEvent('s1', { type: 'approval/asked', data: { toolName: 'Write' } })
    expect(notify).toHaveBeenNthCalledWith(1, 'approval', 'Bash — 越权执行', 's1')
    expect(notify).toHaveBeenNthCalledWith(2, 'approval', 'Write', 's1')
  })
})
