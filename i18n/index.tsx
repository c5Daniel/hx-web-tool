import React, { createContext, useCallback, useContext, useState } from 'react';
import { en } from './en';
import { zhTW } from './zh-TW';

export type Lang = 'zh-TW' | 'en';
export type MessageKey = keyof typeof zhTW;

const DICTS: Record<Lang, Record<MessageKey, string>> = { 'zh-TW': zhTW, en };
const STORAGE_KEY = 'hx-lang';

function loadLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'en' || v === 'zh-TW') return v;
  } catch {
    /* storage blocked: fall back to the default */
  }
  return 'zh-TW';
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(loadLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    document.documentElement.lang = l === 'en' ? 'en' : 'zh-Hant';
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => {
      let s = DICTS[lang][key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      return s;
    },
    [lang],
  );

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}
