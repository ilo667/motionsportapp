import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { announcementExamples, announcements, aiGenerations, trainingDays } from '../database/schema';
import { AnnouncementGeneratorService } from './announcement-generator.service';

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly generator: AnnouncementGeneratorService,
  ) {}

  async listExamples() {
    return this.database.db
      .select()
      .from(announcementExamples)
      .orderBy(announcementExamples.createdAt);
  }

  async addExample(text: string) {
    const [row] = await this.database.db.insert(announcementExamples).values({ text }).returning();
    return row;
  }

  async deleteExample(id: string) {
    await this.database.db.delete(announcementExamples).where(eq(announcementExamples.id, id));
    return { ok: true };
  }

  async getOrCreateForDate(localDate: string) {
    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.localDate, localDate))
      .limit(1);
    if (!day) return null;

    const [existing] = await this.database.db
      .select()
      .from(announcements)
      .where(eq(announcements.trainingDayId, day.id))
      .limit(1);
    if (existing) return existing;

    const [created] = await this.database.db
      .insert(announcements)
      .values({ trainingDayId: day.id })
      .returning();
    return created;
  }

  async setTopic(localDate: string, topic: string) {
    const ann = await this.getOrCreateForDate(localDate);
    if (!ann) return null;
    const [updated] = await this.database.db
      .update(announcements)
      .set({ topic, updatedAt: new Date() })
      .where(eq(announcements.id, ann.id))
      .returning();
    return updated;
  }

  async generateAndSave(localDate: string) {
    const ann = await this.getOrCreateForDate(localDate);
    if (!ann) return null;

    const exampleRows = await this.database.db
      .select({ text: announcementExamples.text })
      .from(announcementExamples)
      .orderBy(announcementExamples.createdAt);

    const result = await this.generator.generate(
      exampleRows.map((e) => e.text),
      ann.topic,
    );

    const [updated] = await this.database.db
      .update(announcements)
      .set({ text: result.text, source: result.source, approvedAt: null, publishedAt: null, updatedAt: new Date() })
      .where(eq(announcements.id, ann.id))
      .returning();

    await this.database.db.insert(aiGenerations).values({
      announcementId: ann.id,
      provider: 'google',
      model: 'gemini-2.0-flash-lite',
      promptVersion: 'v1',
      latencyMs: result.latencyMs ?? null,
      tokenUsage: result.tokenUsage ?? null,
      status: result.source === 'ai' ? 'success' : 'fallback',
      fallbackReason: result.fallbackReason ?? null,
    });

    return updated;
  }

  async updateText(localDate: string, text: string) {
    const ann = await this.getOrCreateForDate(localDate);
    if (!ann) return null;
    const [updated] = await this.database.db
      .update(announcements)
      .set({ text, source: 'manual', approvedAt: null, publishedAt: null, updatedAt: new Date() })
      .where(eq(announcements.id, ann.id))
      .returning();
    return updated;
  }

  async publish(localDate: string) {
    const ann = await this.getOrCreateForDate(localDate);
    if (!ann) return null;
    const now = new Date();
    const [updated] = await this.database.db
      .update(announcements)
      .set({ approvedAt: now, publishedAt: now, updatedAt: now })
      .where(eq(announcements.id, ann.id))
      .returning();
    return updated;
  }

  async unpublish(localDate: string) {
    const ann = await this.getOrCreateForDate(localDate);
    if (!ann) return null;
    const [updated] = await this.database.db
      .update(announcements)
      .set({ approvedAt: null, publishedAt: null, updatedAt: new Date() })
      .where(eq(announcements.id, ann.id))
      .returning();
    return updated;
  }

  async getPublishedTextForDay(trainingDayId: string): Promise<string | null> {
    const [ann] = await this.database.db
      .select({ text: announcements.text, publishedAt: announcements.publishedAt })
      .from(announcements)
      .where(eq(announcements.trainingDayId, trainingDayId))
      .limit(1);
    if (!ann?.publishedAt || !ann.text) return null;
    return ann.text;
  }

  async autoGenerate(localDate: string): Promise<void> {
    const ann = await this.getOrCreateForDate(localDate);
    if (!ann || ann.publishedAt) return;

    const exampleRows = await this.database.db
      .select({ text: announcementExamples.text })
      .from(announcementExamples)
      .orderBy(announcementExamples.createdAt);

    const result = await this.generator.generate(
      exampleRows.map((e) => e.text),
      ann.topic,
    );

    const now = new Date();
    await this.database.db
      .update(announcements)
      .set({ text: result.text, source: result.source, approvedAt: now, publishedAt: now, updatedAt: now })
      .where(eq(announcements.id, ann.id));

    await this.database.db.insert(aiGenerations).values({
      announcementId: ann.id,
      provider: 'google',
      model: 'gemini-2.0-flash-lite',
      promptVersion: 'v1',
      latencyMs: result.latencyMs ?? null,
      tokenUsage: result.tokenUsage ?? null,
      status: result.source === 'ai' ? 'success' : 'fallback',
      fallbackReason: result.fallbackReason ?? null,
    });
  }
}