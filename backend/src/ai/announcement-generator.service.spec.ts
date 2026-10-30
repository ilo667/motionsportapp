import { AnnouncementGeneratorService, withoutLongDash } from './announcement-generator.service';

const GYM_NAMES = ['MotionSport', 'Motion Gym', 'MotionGym', 'мотіонспорт', 'моушн джим'];

let capturedPrompt = '';
let capturedSystem = '';

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockImplementation((opts: { systemInstruction?: string }) => {
      capturedSystem = opts.systemInstruction ?? '';
      return {
        generateContent: jest.fn().mockImplementation((prompt: string) => {
          capturedPrompt = prompt;
          return Promise.resolve({
            response: {
              text: () => 'Записуйтесь на тренування сьогодні! 💪',
              usageMetadata: { totalTokenCount: 20 },
            },
          });
        }),
      };
    }),
  })),
}));

describe('AnnouncementGeneratorService', () => {
  let service: AnnouncementGeneratorService;

  beforeEach(() => {
    capturedPrompt = '';
    capturedSystem = '';
    service = new AnnouncementGeneratorService();
  });

  describe('when GEMINI_API_KEY is not set', () => {
    beforeEach(() => {
      delete process.env.GEMINI_API_KEY;
    });

    it('returns fallback text', async () => {
      const result = await service.generate([]);
      expect(result.source).toBe('fallback');
      expect(result.text).toBeTruthy();
    });

    it('does not call Gemini API', async () => {
      const { GoogleGenerativeAI } = jest.requireMock('@google/generative-ai');
      GoogleGenerativeAI.mockClear();
      await service.generate([]);
      expect(GoogleGenerativeAI).not.toHaveBeenCalled();
    });
  });

  describe('when GEMINI_API_KEY is set', () => {
    beforeEach(() => {
      process.env.GEMINI_API_KEY = 'test-key';
    });
    afterEach(() => {
      delete process.env.GEMINI_API_KEY;
    });

    it('returns AI-generated text', async () => {
      const result = await service.generate(['Приклад 1']);
      expect(result.source).toBe('ai');
      expect(result.text).toBe('Записуйтесь на тренування сьогодні! 💪');
    });

    it('prompt and system instruction do not mention the gym name', async () => {
      await service.generate(['Приклад оголошення']);
      for (const name of GYM_NAMES) {
        expect(capturedPrompt.toLowerCase()).not.toContain(name.toLowerCase());
        expect(capturedSystem.toLowerCase()).not.toContain(name.toLowerCase());
      }
    });

    it('system instruction holds the weekly programme (Mon legs, Wed circuit, Fri arms)', async () => {
      await service.generate([]);
      expect(capturedSystem).toContain('понеділок: ноги');
      expect(capturedSystem).toContain('середа: кругове тренування');
      expect(capturedSystem).toContain('пʼятниця: руки');
    });

    it('prompt names the weekday of the training so the model picks the topic', async () => {
      await service.generate([], null, '2026-10-26');
      expect(capturedPrompt).toContain('понеділок, 26 жовтня');
      expect(capturedPrompt).not.toContain('Окрема тема');
    });

    it('prompt includes provided examples', async () => {
      await service.generate(['Перший приклад', 'Другий приклад']);
      expect(capturedPrompt).toContain('Перший приклад');
      expect(capturedPrompt).toContain('Другий приклад');
    });

    it('a topic set for the day goes into the prompt as an override', async () => {
      await service.generate([], 'Спина', '2026-10-26');
      expect(capturedPrompt).toContain('Окрема тема на цей день: Спина');
    });

    it('returns fallback when Gemini returns empty text', async () => {
      const { GoogleGenerativeAI } = jest.requireMock('@google/generative-ai');
      GoogleGenerativeAI.mockImplementationOnce(() => ({
        getGenerativeModel: jest.fn().mockReturnValue({
          generateContent: jest.fn().mockResolvedValue({
            response: { text: () => '', usageMetadata: {} },
          }),
        }),
      }));
      (service as any).genAI = null;
      const result = await service.generate([]);
      expect(result.source).toBe('fallback');
    });
  });
});

describe('withoutLongDash', () => {
  it('puts a comma for a long dash, never one before the end mark', () => {
    expect(withoutLongDash('Записуйтесь — місця обмежені.')).toBe('Записуйтесь, місця обмежені.');
    expect(withoutLongDash('Ноги сьогодні —!')).toBe('Ноги сьогодні!');
    expect(withoutLongDash('— Ноги сьогодні')).toBe('Ноги сьогодні');
    expect(withoutLongDash('Без тире 💪')).toBe('Без тире 💪');
  });
});
