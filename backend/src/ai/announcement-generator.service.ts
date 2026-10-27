import { Injectable } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { DateTime } from 'luxon';
import { KY_ZONE } from '../schedule/training-types';

const FALLBACK_TEXT = 'Записуйтесь на тренування! 💪 Чекаємо вас сьогодні.';
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
// Bump when the instructions change (stored in ai_generations.prompt_version)
export const PROMPT_VERSION = 'v3';

// Stable part of every request: who writes, the gym's weekly programme, and the format.
// The model picks the topic from the weekday it gets in the prompt
const SYSTEM_INSTRUCTION = `Ти тренер жіночого фітнес-залу. Пишеш короткі мотиваційні оголошення українською мовою, щоб запросити записатися на групове тренування.

Тижнева програма групових тренувань:
- понеділок: ноги
- середа: кругове тренування
- пʼятниця: руки

Якщо в запиті вказано окрему тему на цей день, вона важливіша за тижневу програму.

Вимоги до оголошення:
- 1-2 речення, максимум 150 символів
- згадай тему тренування
- дружній, енергійний, мотивуючий тон
- можна 1-2 емодзі
- тільки текст оголошення, без пояснень і заголовків
- не називай зал
- без довгого тире (—), став кому або крапку`;

// The UI never shows a long dash (the members' texts don't use it); the model sometimes writes one anyway
export function withoutLongDash(text: string) {
  return text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/^,\s*/, '')
    .replace(/,\s*([.!?])/g, '$1');
}

export interface GenerateResult {
  text: string;
  model: string;
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

  // localDate gives the weekday (→ topic from the weekly programme); topic overrides it for that day
  async generate(examples: string[], topic?: string | null, localDate?: string): Promise<GenerateResult> {
    const ai = this.ensureInit();
    if (!ai) {
      return { text: FALLBACK_TEXT, model: GEMINI_MODEL, source: 'fallback', fallbackReason: 'GEMINI_API_KEY not set' };
    }

    const examplesText =
      examples.length > 0
        ? examples.map((e, i) => `${i + 1}. ${withoutLongDash(e)}`).join('\n')
        : '1. Сьогодні тренуємось! 💪 Записуйтесь, місця обмежені.';

    const day = localDate
      ? DateTime.fromISO(localDate, { zone: KY_ZONE }).setLocale('uk').toFormat('cccc, d MMMM')
      : null;

    const prompt = `Напиши одне оголошення про тренування сьогодні${day ? ` (${day})` : ''}.

Стиль (приклади попередніх оголошень):
${examplesText}
${topic ? `\nОкрема тема на цей день: ${topic}` : ''}`;

    const start = Date.now();
    try {
      const geminiModel = ai.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: SYSTEM_INSTRUCTION });
      const result = await geminiModel.generateContent(prompt);
      const latencyMs = Date.now() - start;
      const raw = result.response.text().trim().replace(/\n+/g, ' ');
      const text = withoutLongDash(raw).substring(0, 300);
      const tokenUsage = result.response.usageMetadata?.totalTokenCount;

      if (!text) {
        return {
          text: FALLBACK_TEXT,
          model: GEMINI_MODEL,
          source: 'fallback',
          fallbackReason: 'empty response',
          latencyMs,
        };
      }
      return { text, model: GEMINI_MODEL, source: 'ai', latencyMs, tokenUsage };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const fallbackReason = err instanceof Error ? err.message.substring(0, 200) : String(err).substring(0, 200);
      return { text: FALLBACK_TEXT, model: GEMINI_MODEL, source: 'fallback', fallbackReason, latencyMs };
    }
  }
}
