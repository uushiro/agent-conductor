import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LangProvider } from './contexts/LangContext'
import { SettingsProvider } from './contexts/SettingsContext'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <LangProvider>
        <App />
      </LangProvider>
    </SettingsProvider>
  </StrictMode>
)
