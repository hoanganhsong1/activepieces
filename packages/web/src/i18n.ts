import { LocalesEnum } from '@activepieces/core-utils';
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import Backend from 'i18next-http-backend';
import ICU from 'i18next-icu';
import { initReactI18next } from 'react-i18next';

i18n
  .use(ICU)
  .use(Backend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: LocalesEnum.JAPANESE,
    debug: false,
    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },
    supportedLngs: Object.values(LocalesEnum),
    keySeparator: false,
    nsSeparator: false,
    returnEmptyString: false,
    detection: {
      // Only respect an explicit choice (URL param, cookie, or a previous
      // manual selection). Do not auto-detect from the browser/OS locale,
      // so first-time visitors always land on Japanese by default.
      order: ['querystring', 'cookie', 'localStorage', 'sessionStorage'],
      caches: ['localStorage', 'cookie'],
    },
  });
export default i18n;
