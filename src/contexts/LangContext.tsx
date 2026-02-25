import { createContext, useContext, useState } from 'react'

export type Lang = 'ja' | 'en'

export const strings = {
  ja: {
    openInEditor: 'エディタで開く',
    copyPath: 'パスをコピー',
    setAsRoot: 'ルートに設定',
    copied: '✓ パスをコピーしました',
    quitConfirm: 'もう一度 ⌘Q を押すと終了します',
    helpTabs: 'タブ: + で追加（Claude/Gemini/Terminal）。ダブルクリックでタブ名変更。ドラッグで並べ替え。↺ で閉じたタブを復元。',
    helpSessions: 'セッション: 終了時に自動保存、起動時に自動復元。復元中は "Resuming..." と表示。',
    helpSidebar: 'サイドバー: セッション一覧（緑ドット=実行中）。下部にタスクリスト — 追加・チェックで完了・ダブルクリックで編集。◆ でタスクを新しいタブに送信。',
    helpTasksFromClaude: 'Claude からタスク追加: Claude の出力に [[TASK: タイトル]] を含めると自動追加。',
    helpFileTree: 'ファイルツリー: ▤ で表示切替。アクティブタブのディレクトリに自動追従。パスをクリックでディレクトリ固定。右クリックでメニュー。',
    helpTerminal: 'ターミナル: テキスト選択 + Backspace で一括削除。カラム幅はドラッグで調整可能（再起動後も保持）。',
  },
  en: {
    openInEditor: 'Open in Editor',
    copyPath: 'Copy Path',
    setAsRoot: 'Set as Root',
    copied: '✓ Path copied',
    quitConfirm: 'Press ⌘Q again to quit',
    helpTabs: 'Tabs: + to add (Claude/Gemini/Terminal). Double-click tab to rename. Drag to reorder. ↺ to restore closed tabs.',
    helpSessions: 'Sessions: Auto-saved on quit, auto-resumed on launch. "Resuming..." shown while restoring.',
    helpSidebar: 'Sidebar: Session list with status dots (green=active). Task list below — add tasks, check to complete, double-click to edit. ◆ sends task to new agent tab.',
    helpTasksFromClaude: 'Tasks from Claude: Include [[TASK: title]] in Claude output to auto-add tasks.',
    helpFileTree: 'File Tree: Toggle with ▤. Auto-follows active tab\'s cwd. Click path to pin a directory. Right-click files for context menu.',
    helpTerminal: 'Terminal: Select text + Backspace to bulk-delete. Column widths are draggable and persisted.',
  },
} satisfies Record<Lang, Record<string, string>>

const LangContext = createContext<{ lang: Lang; toggleLang: () => void }>({
  lang: 'ja',
  toggleLang: () => {},
})

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>(
    () => (localStorage.getItem('lang') as Lang) || 'en'
  )

  const toggleLang = () => {
    setLang((prev) => {
      const next = prev === 'ja' ? 'en' : 'ja'
      localStorage.setItem('lang', next)
      return next
    })
  }

  return (
    <LangContext.Provider value={{ lang, toggleLang }}>
      {children}
    </LangContext.Provider>
  )
}

export function useLang() {
  return useContext(LangContext)
}
