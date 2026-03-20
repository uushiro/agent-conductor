import { version as VERSION } from '../../package.json'

export function SplashScreen() {
  return (
    <div className="splash">
      <div className="splash-content">
        <svg className="splash-icon" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="baton-splash" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" style={{ stopColor: '#3fb950' }} />
              <stop offset="40%" style={{ stopColor: '#58a6ff' }} />
              <stop offset="100%" style={{ stopColor: '#bc8cff' }} />
            </linearGradient>
          </defs>
          <rect width="128" height="128" rx="28" fill="#0d1117"/>
          <rect x="18" y="42" width="44" height="30" rx="5" fill="none" stroke="#9b59b6" strokeWidth="1.8" opacity="0.4"/>
          <circle cx="25" cy="49" r="2" fill="#9b59b6" opacity="0.6"/>
          <rect x="26" y="50" width="44" height="30" rx="5" fill="none" stroke="#3fb950" strokeWidth="1.8" opacity="0.55"/>
          <circle cx="33" cy="57" r="2" fill="#3fb950" opacity="0.7"/>
          <rect x="34" y="58" width="44" height="30" rx="5" fill="none" stroke="#58a6ff" strokeWidth="2.2"/>
          <circle cx="41" cy="65" r="2.5" fill="#58a6ff"/>
          <path d="M48 100 Q70 54 98 20" fill="none" stroke="url(#baton-splash)" strokeWidth="0.8" strokeLinecap="round" opacity="0.06"/>
          <path d="M50 99 Q72 52 100 21" fill="none" stroke="url(#baton-splash)" strokeWidth="1.2" strokeLinecap="round" opacity="0.08"/>
          <path d="M52 98 Q74 51 102 22" fill="none" stroke="url(#baton-splash)" strokeWidth="1.8" strokeLinecap="round" opacity="0.12"/>
          <path d="M54 97 Q76 50 104 23" fill="none" stroke="url(#baton-splash)" strokeWidth="2.5" strokeLinecap="round" opacity="0.18"/>
          <path d="M56 96 Q78 48 106 24" fill="none" stroke="url(#baton-splash)" strokeWidth="4" strokeLinecap="round"/>
          <path d="M58 97 Q80 50 108 25" fill="none" stroke="url(#baton-splash)" strokeWidth="2.5" strokeLinecap="round" opacity="0.15"/>
          <path d="M60 98 Q82 52 110 26" fill="none" stroke="url(#baton-splash)" strokeWidth="1.8" strokeLinecap="round" opacity="0.08"/>
          <path d="M62 99 Q84 54 112 27" fill="none" stroke="url(#baton-splash)" strokeWidth="1" strokeLinecap="round" opacity="0.04"/>
          <circle cx="106" cy="24" r="6" fill="#bc8cff"/>
          <circle cx="106" cy="24" r="12" fill="#bc8cff" opacity="0.1"/>
        </svg>
        <div className="splash-name">Agent Conductor</div>
        <div className="splash-version">v{VERSION}</div>
        <div className="splash-loader">
          <div className="splash-bar" />
        </div>
      </div>
    </div>
  )
}
