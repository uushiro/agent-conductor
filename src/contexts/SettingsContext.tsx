import { createContext, useContext, useState, useEffect, useRef } from 'react'

export type Theme = 'dark' | 'light'

export type DefaultAgent = 'claude' | 'gemini' | 'codex'

interface Settings {
  theme: Theme
  fontSize: number
  editorCommand: string
  customEditors: string[]
  accentColor: string
  customColors: string[]
  defaultAgent: DefaultAgent
  fileTreeVisible: boolean
  fileTreeRoot: string | null
  fileTreePinned: boolean
}

interface SettingsContextValue extends Settings {
  updateSettings: (patch: Partial<Settings>) => void
  loaded: boolean
}

const DEFAULTS: Settings = {
  theme: 'dark',
  fontSize: 14,
  editorCommand: '',
  customEditors: [],
  accentColor: '#58a6ff',
  customColors: [],
  defaultAgent: 'claude',
  fileTreeVisible: true,
  fileTreeRoot: null,
  fileTreePinned: false,
}

const SettingsContext = createContext<SettingsContextValue>({
  ...DEFAULTS,
  updateSettings: () => {},
  loaded: false,
})

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULTS })
  const [loaded, setLoaded] = useState(false)
  const initializedRef = useRef(false)

  // Load from file on mount (overrides defaults)
  // Show splash for at least 700ms so it's visible
  useEffect(() => {
    const finish = (saved?: Record<string, unknown> | null) => {
      if (saved) setSettings({ ...DEFAULTS, ...saved })
      initializedRef.current = true
      setLoaded(true)
      // Directly remove splash from DOM as a reliable fallback
      const splash = document.getElementById('splash')
      if (splash) {
        splash.style.transition = 'opacity 0.3s ease'
        splash.style.opacity = '0'
        setTimeout(() => splash.remove(), 300)
      }
    }

    // Fallback: force loaded after 5s no matter what
    const fallback = setTimeout(() => finish(), 5000)

    try {
      const timerPromise = new Promise<void>((r) => setTimeout(r, 2000))
      Promise.all([window.electronAPI.loadAppSettings(), timerPromise]).then(([saved]) => {
        clearTimeout(fallback)
        finish(saved)
      }).catch(() => {
        clearTimeout(fallback)
        finish()
      })
    } catch {
      clearTimeout(fallback)
      finish()
    }
  }, [])

  // Save to file whenever settings change (skip before first load)
  useEffect(() => {
    if (!initializedRef.current) return
    window.electronAPI.saveAppSettings(JSON.stringify(settings))
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--accent', settings.accentColor)
  }, [settings])

  // Apply theme + accent on initial render
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--accent', settings.accentColor)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const updateSettings = (patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }

  return (
    <SettingsContext.Provider value={{ ...settings, updateSettings, loaded }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  return useContext(SettingsContext)
}
