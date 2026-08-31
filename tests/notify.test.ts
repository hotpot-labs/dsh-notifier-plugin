import { describe, expect, it } from 'vitest'
import {
  approvalDetail,
  blockedBody,
  blockedQuestionText,
  buildBody,
  clipTitle,
  resultText,
} from '../src/notify.js'

describe('resultText', () => {
  it('maps every harness turn/end kind', () => {
    expect(resultText('completed')).toBe('任务已完成')
    expect(resultText('error')).toBe('任务失败')
    expect(resultText('aborted')).toBe('任务已中止')
    expect(resultText('max-tokens')).toBe('任务达到 token 上限')
    expect(resultText('blocked')).toBe('任务被阻塞')
    expect(resultText('interrupted')).toBe('任务被中断')
  })

  it('falls through unknown kinds to a generic end', () => {
    expect(resultText('unknown')).toBe('任务结束')
    expect(resultText('')).toBe('任务结束')
  })
})

describe('clipTitle', () => {
  it('trims and passes through ordinary titles', () => {
    expect(clipTitle('  修复登录bug  ')).toBe('修复登录bug')
  })

  it('normalizes blank and non-string input to empty', () => {
    expect(clipTitle('   ')).toBe('')
    expect(clipTitle(undefined)).toBe('')
    expect(clipTitle(42)).toBe('')
  })

  it('truncates long titles to 80 code points with an ellipsis', () => {
    const title = clipTitle('x'.repeat(100))
    expect([...title]).toHaveLength(81)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('buildBody', () => {
  it('combines result and title', () => {
    expect(buildBody('任务已完成', '修复登录bug')).toBe('任务已完成 - 任务：修复登录bug')
  })

  it('omits an empty title', () => {
    expect(buildBody('任务已完成')).toBe('任务已完成')
  })
})

describe('blockedQuestionText', () => {
  it('extracts the first question from an ask_user_question arguments string', () => {
    const args = JSON.stringify({ questions: [{ question: '  要继续吗？ ' }] })
    expect(blockedQuestionText(args)).toBe('要继续吗？')
  })

  it('returns empty for malformed JSON or missing questions', () => {
    expect(blockedQuestionText('not json')).toBe('')
    expect(blockedQuestionText('{}')).toBe('')
    expect(blockedQuestionText(JSON.stringify({ questions: [] }))).toBe('')
    expect(blockedQuestionText(JSON.stringify({ questions: [{ question: 42 }] }))).toBe('')
  })

  it('truncates long questions to 80 code points with an ellipsis', () => {
    const args = JSON.stringify({ questions: [{ question: 'x'.repeat(100) }] })
    const text = blockedQuestionText(args)
    expect([...text]).toHaveLength(81)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('blockedBody', () => {
  it('labels questions and approvals', () => {
    expect(blockedBody('question', '要继续吗？', 'abc')).toBe('需要回答：要继续吗？')
    expect(blockedBody('approval', 'Bash — 越权', 'abc')).toBe('需要批准：Bash — 越权')
  })

  it('falls back to the generic text for empty details and unknown kinds', () => {
    expect(blockedBody('question', '', 'abc')).toBe('需要处理')
    expect(blockedBody('other', 'whatever', 'abc')).toBe('需要处理')
  })

  it('appends the session title when present', () => {
    expect(blockedBody('approval', 'Bash', 'abc', '重构数据库')).toBe('需要批准：Bash — 重构数据库')
  })
})

describe('approvalDetail', () => {
  it('combines tool name and reason', () => {
    expect(approvalDetail('Bash', '越权执行')).toBe('Bash — 越权执行')
    expect(approvalDetail('Bash', '')).toBe('Bash')
    expect(approvalDetail('', 'reason')).toBe('')
  })
})
