import { createContext, useContext, useState, useEffect } from 'react'

export type Theme = 'dark' | 'light'

interface Settings {
  theme: Theme
  fontSize: number
  editorCommand: string
  customEditors: string[]
  accentColor: string
  customColors: string[]
}

interface SettingsContextValue extends Settings {
  updateSettings: (patch: Partial<Settings>) => void
}

const DEFAULTS: Settings = {
  theme: 'dark',
  fontSize: 14,
  editorCommand: '',
  customEditors: [],
  accentColor: '#58a6ff',
  customColors: [],
}

const STORAGE_KEY = 'agent-conductor-settings'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

const SettingsContext = createContext<SettingsContextValue>({
  ...DEFAULTS,
  updateSettings: () => {},
})

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--accent', settings.accentColor)
  }, [settings])

  // Apply theme + accent on initial render (before first effect)
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--accent', settings.accentColor)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const updateSettings = (patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }

  return (
    <SettingsContext.Provider value={{ ...settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  return useContext(SettingsContext)
}
