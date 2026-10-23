import { Injectable } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { vacancyAlerts } from '../database/schema';

@Injectable()
export class VacancyAlertsService {
  constructor(private readonly database: DatabaseService) {}

  async subscribe(memberId: string, slotId: string) {
    await this.database.db
      .insert(vacancyAlerts)
      .values({ memberId, slotId, active: true })
      .onConflictDoUpdate({
        target: [vacancyAlerts.memberId, vacancyAlerts.slotId],
        set: { active: true },
      });
  }

  async unsubscribe(memberId: string, slotId: string) {
    await this.database.db
      .update(vacancyAlerts)
      .set({ active: false })
      .where(and(eq(vacancyAlerts.memberId, memberId), eq(vacancyAlerts.slotId, slotId)));
  }

  async findActiveSubscribersBySlot(slotId: string, excludeMemberId?: string) {
    const rows = await this.database.db
      .select({ memberId: vacancyAlerts.memberId })
      .from(vacancyAlerts)
      .where(and(eq(vacancyAlerts.slotId, slotId), eq(vacancyAlerts.active, true)));
    return rows.map((r) => r.memberId).filter((id) => id !== excludeMemberId);
  }

  async deactivateBySlot(slotId: string) {
    await this.database.db.update(vacancyAlerts).set({ active: false }).where(eq(vacancyAlerts.slotId, slotId));
  }
}
