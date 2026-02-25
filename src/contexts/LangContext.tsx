import { createContext, useContext, useState } from 'react'

export type Lang = 'ja' | 'en'

export const strings = {
  ja: {
    openInEditor: 'エディタで開く',
    copyPath: 'パスをコピー',
    setAsRoot: 'ルートに設定',
    copied: '✓ パスをコピーしました',
    quitConfirm: 'もう一度 ⌘Q を押すと終了します',
  },
  en: {
    openInEditor: 'Open in Editor',
    copyPath: 'Copy Path',
    setAsRoot: 'Set as Root',
    copied: '✓ Path copied',
    quitConfirm: 'Press ⌘Q again to quit',
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
