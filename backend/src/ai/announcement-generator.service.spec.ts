import { AnnouncementGeneratorService } from './announcement-generator.service';

const GYM_NAMES = ['MotionSport', 'Motion Gym', 'MotionGym', 'мотіонспорт', 'моушн джим'];

let capturedPrompt = '';

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return Promise.resolve({
          response: {
            text: () => 'Записуйтесь на тренування сьогодні! 💪',
            usageMetadata: { totalTokenCount: 20 },
          },
        });
      }),
    }),
  })),
}));

describe('AnnouncementGeneratorService', () => {
  let service: AnnouncementGeneratorService;

  beforeEach(() => {
    capturedPrompt = '';
    service = new AnnouncementGeneratorService();
  });

  describe('when GEMINI_API_KEY is not set', () => {
    beforeEach(() => { delete process.env.GEMINI_API_KEY; });

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
    beforeEach(() => { process.env.GEMINI_API_KEY = 'test-key'; });
    afterEach(() => { delete process.env.GEMINI_API_KEY; });

    it('returns AI-generated text', async () => {
      const result = await service.generate(['Приклад 1']);
      expect(result.source).toBe('ai');
      expect(result.text).toBe('Записуйтесь на тренування сьогодні! 💪');
    });

    it('prompt does not mention the gym name', async () => {
      await service.generate(['Приклад оголошення']);
      for (const name of GYM_NAMES) {
        expect(capturedPrompt.toLowerCase()).not.toContain(name.toLowerCase());
      }
    });

    it('prompt includes provided examples', async () => {
      await service.generate(['Перший приклад', 'Другий приклад']);
      expect(capturedPrompt).toContain('Перший приклад');
      expect(capturedPrompt).toContain('Другий приклад');
    });

    it('prompt includes topic when provided', async () => {
      await service.generate([], 'Кардіо');
      expect(capturedPrompt).toContain('Кардіо');
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
      // Reset lazy init
      (service as any).genAI = null;
      const result = await service.generate([]);
      expect(result.source).toBe('fallback');
    });
  });
});