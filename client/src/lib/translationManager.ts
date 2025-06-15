import { apiRequest } from './queryClient';
import type { Message } from '@shared/schema';

class TranslationManager {
  private authenticationRequired = false;
  private translationCache = new Map<string, string>(); // Simple in-memory cache

  setUserLanguage(language: string) {
    console.log(`🌐 User language set to: ${language}`);
  }

  resetAuthenticationStatus() {
    this.authenticationRequired = false;
    console.log(`🔓 Authentication status reset, translations enabled`);
  }

  translateMessage(
    message: Message, 
    targetLanguage: string, 
    priority: 'high' | 'normal' | 'low' = 'normal',
    callback: (result: string) => void
  ): void {
    const text = message.originalText || '';
    
    if (this.authenticationRequired) {
      callback(text);
      return;
    }

    // Simple language detection
    const detectLanguage = (text: string): string => {
      if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text)) return 'ja';
      if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
      if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
      if (/[\u0600-\u06FF]/.test(text)) return 'ar';
      if (/[\u0400-\u04FF]/.test(text)) return 'ru';
      return 'en';
    };
    
    const sourceLanguage = detectLanguage(text);
    
    if (sourceLanguage === targetLanguage) {
      callback(text);
      return;
    }

    // Check cache first
    const cacheKey = `${text}|${sourceLanguage}|${targetLanguage}`;
    const cached = this.translationCache.get(cacheKey);
    
    if (cached) {
      console.log(`💾 Using cached translation: "${text}" -> "${cached}"`);
      callback(cached);
      return;
    }

    console.log(`🔄 Translating: "${text}" (${sourceLanguage} -> ${targetLanguage})`);
    
    // Translate and cache result
    this.performTranslation(text, sourceLanguage, targetLanguage, (result) => {
      if (result !== text) {
        this.translationCache.set(cacheKey, result);
      }
      callback(result);
    });
  }

  private async performTranslation(
    text: string, 
    source: string, 
    target: string, 
    callback: (result: string) => void
  ): Promise<void> {
    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text, source, target })
      });

      if (!response.ok) {
        if (response.status === 401) {
          this.authenticationRequired = true;
          console.log(`🔒 Translation requires authentication`);
        }
        callback(text);
        return;
      }

      const result = await response.json();
      const translatedText = result.translatedText || text;
      
      console.log(`✅ Translation result: "${text}" -> "${translatedText}"`);
      callback(translatedText);
    } catch (error) {
      console.error('Translation error:', error);
      callback(text);
    }
  }
}

export const translationManager = new TranslationManager();