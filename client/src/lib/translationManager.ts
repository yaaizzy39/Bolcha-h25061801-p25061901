import type { Message } from '@shared/schema';
import { apiRequest } from '@/lib/queryClient';

// Simple translation cache in localStorage
const CACHE_KEY = 'bolcha_translations';

interface CacheEntry {
  text: string;
  source: string;
  target: string;
  translatedText: string;
  timestamp: number;
}

class TranslationManager {
  private userLanguage = 'ja';
  private cache: Map<string, CacheEntry> = new Map();
  private isProcessing = false;

  constructor() {
    // Load cached translations from localStorage (if any)
    this.loadCache();
    try {
      const storedLang = localStorage.getItem('selectedLanguage');
      if (storedLang) {
        this.userLanguage = storedLang;
      }
    } catch {
      /* localStorage might be unavailable (SSR) */
    }
  }

  setUserLanguage(language: string) {
    this.userLanguage = language;
  }

  getUserLanguage(): string {
    return this.userLanguage;
  }

  get currentUserLanguage() {
    return this.userLanguage;
  }

  resetAuthenticationStatus() {
    // Clear cache on auth reset
    this.cache.clear();
    this.saveCache();
  }

  private loadCache() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const entries = JSON.parse(cached);
        this.cache = new Map(entries);
      }
    } catch (error) {
      console.error('Failed to load translation cache:', error);
      this.cache.clear();
    }
  }

  private saveCache() {
    try {
      const entries = Array.from(this.cache.entries());
      localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
    } catch (error) {
      console.error('Failed to save translation cache:', error);
    }
  }

  private getCacheKey(text: string, source: string, target: string): string {
    return `${source}-${target}-${text}`;
  }

  async translateMessage(
    message: Message,
    targetLanguage: string,
    priority: 'high' | 'normal' | 'low' = 'normal',
    callback: (result: string) => void
  ): Promise<void> {
    if (!message.originalText) {
      callback('');
      return;
    }

    const sourceLanguage = message.originalLanguage || this.detectLanguage(message.originalText);

    // No need to translate if already in target language
    if (sourceLanguage === targetLanguage) {
      callback(message.originalText);
      return;
    }

    const cacheKey = this.getCacheKey(message.originalText, sourceLanguage, targetLanguage);
    if (this.cache.has(cacheKey)) {
      callback(this.cache.get(cacheKey)!.translatedText);
      return;
    }

    try {
      // Use apiRequest helper so we keep consistent error handling/credentials
      const res = await apiRequest('POST', '/api/translate', {
        text: message.originalText,
        source: sourceLanguage,
        target: targetLanguage,
        priority,
      });
      const data = await res.json();
      const translated: string = data?.translatedText || message.originalText;

      // Cache and persist
      this.cache.set(cacheKey, {
        text: message.originalText,
        source: sourceLanguage,
        target: targetLanguage,
        translatedText: translated,
        timestamp: Date.now(),
      });
      this.saveCache();

      callback(translated);
    } catch (err) {
      console.error('Translation API error:', err);
      callback(message.originalText);
    }
  }

  private detectLanguage(text: string): string {
    const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/;
    const chineseRegex = /[\u4E00-\u9FFF]/;
    const koreanRegex = /[\uAC00-\uD7AF]/;
    const arabicRegex = /[\u0600-\u06FF]/;
    const thaiRegex = /[\u0E00-\u0E7F]/;
    const hindiRegex = /[\u0900-\u097F]/;
    
    if (japaneseRegex.test(text)) return 'ja';
    if (chineseRegex.test(text)) return 'zh';
    if (koreanRegex.test(text)) return 'ko';
    if (arabicRegex.test(text)) return 'ar';
    if (thaiRegex.test(text)) return 'th';
    if (hindiRegex.test(text)) return 'hi';
    
    return 'en';
  }
}

export const translationManager = new TranslationManager();