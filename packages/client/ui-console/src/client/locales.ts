/** Simplified Chinese Human Terminal copy and key source. */
export const zh = {
  newTerminal: '新建终端',
  terminal: '终端',
  archived: '已归档',
  ended: '已结束',
  rename: '重命名',
  archive: '归档',
  restore: '恢复',
  terminate: '终止',
  terminateConfirm: '终止会结束 tmux session 和其中运行的程序。确定继续吗？',
  splitRight: '在右侧分屏打开',
  splitDown: '在下方分屏打开',
  creating: '正在创建…',
  noWorkspace: '请先添加工作区',
  actions: '终端操作',
  renamePrompt: '终端名称',
} satisfies Record<string, string>

/** Human Terminal locale key union. */
export type ConsoleLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  newTerminal: 'New terminal',
  terminal: 'Terminal',
  archived: 'Archived',
  ended: 'Ended',
  rename: 'Rename',
  archive: 'Archive',
  restore: 'Restore',
  terminate: 'Terminate',
  terminateConfirm: 'Terminate the tmux session and every program running inside it?',
  splitRight: 'Open in split right',
  splitDown: 'Open in split down',
  creating: 'Creating…',
  noWorkspace: 'Add a workspace first',
  actions: 'Terminal actions',
  renamePrompt: 'Terminal name',
} satisfies Record<ConsoleLocaleKey, string>
