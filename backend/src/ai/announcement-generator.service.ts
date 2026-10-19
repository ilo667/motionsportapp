import { Injectable } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';

const FALLBACK_TEXT = 'Записуйтесь на тренування! 💪 Чекаємо вас сьогодні.';

export interface GenerateResult {
  text: string;
  source: 'ai' | 'fallback';
  latencyMs?: number;
  tokenUsage?: number;
  fallbackReason?: string;
}

@Injectable()
export class AnnouncementGeneratorService {
  private genAI: GoogleGenerativeAI | null = null;

  private ensureInit(): GoogleGenerativeAI | null {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    if (!this.genAI) this.genAI = new GoogleGenerativeAI(key);
    return this.genAI;
  }

  async generate(examples: string[], topic?: string | null): Promise<GenerateResult> {
    const ai = this.ensureInit();
    if (!ai) {
      return { text: FALLBACK_TEXT, source: 'fallback', fallbackReason: 'GEMINI_API_KEY not set' };
    }

    const examplesText =
      examples.length > 0
        ? examples.map((e, i) => `${i + 1}. ${e}`).join('\n')
        : '1. Сьогодні тренуємось! 💪 Записуйтесь — місця обмежені.';

    const prompt = `Ти тренер жіночого фітнес-залу MotionSport. Напиши одне коротке мотиваційне оголошення українською мовою для запрошення записатися на тренування сьогодні.

Стиль (приклади попередніх оголошень):
${examplesText}

${topic ? `Тема тренування: ${topic}` : 'Загальне запрошення на тренування.'}

Вимоги:
- 1-2 речення, максимум 150 символів
- Дружній, енергійний, мотивуючий тон
- Можна використовувати 1-2 емодзі
- Тільки текст оголошення, без пояснень і заголовків`;

    const start = Date.now();
    try {
      const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
      const result = await model.generateContent(prompt);
      const latencyMs = Date.now() - start;
      const raw = result.response.text().trim().replace(/\n+/g, ' ');
      const text = raw.substring(0, 300);
      const tokenUsage = result.response.usageMetadata?.totalTokenCount;

      if (!text) {
        return { text: FALLBACK_TEXT, source: 'fallback', fallbackReason: 'empty response', latencyMs };
      }
      return { text, source: 'ai', latencyMs, tokenUsage };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const fallbackReason = err instanceof Error ? err.message.substring(0, 200) : String(err).substring(0, 200);
      return { text: FALLBACK_TEXT, source: 'fallback', fallbackReason, latencyMs };
    }
  }
}