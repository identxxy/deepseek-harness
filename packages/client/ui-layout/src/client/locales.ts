/** Simplified Chinese pane-canvas copy and key source. */
export const zh = {
  agent: 'Agent',
  terminal: '终端',
  sessionUnavailable: '会话不可用',
  splitRight: '向右分屏',
  splitDown: '向下分屏',
  closePane: '关闭窗格',
} satisfies Record<string, string>

/** Pane-canvas locale key union. */
export type LayoutLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  agent: 'Agent',
  terminal: 'Terminal',
  sessionUnavailable: 'Session unavailable',
  splitRight: 'Split right',
  splitDown: 'Split down',
  closePane: 'Close pane',
} satisfies Record<LayoutLocaleKey, string>
