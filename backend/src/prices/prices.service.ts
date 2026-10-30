import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, asc, desc } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import { priceItems, priceChanges, admins } from '../database/schema';
import type { UpdatePriceDto } from './dto/update-price.dto';

const CHANGES_LIMIT = 30;

@Injectable()
export class PricesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
  ) {}

  async getPrices() {
    const items = await this.database.db
      .select({
        id: priceItems.id,
        section: priceItems.section,
        title: priceItems.title,
        optionLabel: priceItems.optionLabel,
        amountUah: priceItems.amountUah,
        updatedBy: admins.username,
        updatedAt: priceItems.updatedAt,
      })
      .from(priceItems)
      .leftJoin(admins, eq(admins.id, priceItems.updatedBy))
      .orderBy(asc(priceItems.sortOrder));

    const changes = await this.database.db
      .select({
        id: priceChanges.id,
        title: priceItems.title,
        optionLabel: priceItems.optionLabel,
        oldAmountUah: priceChanges.oldAmountUah,
        newAmountUah: priceChanges.newAmountUah,
        changedBy: admins.username,
        changedAt: priceChanges.changedAt,
      })
      .from(priceChanges)
      .innerJoin(priceItems, eq(priceItems.id, priceChanges.priceItemId))
      .innerJoin(admins, eq(admins.id, priceChanges.changedBy))
      .orderBy(desc(priceChanges.changedAt))
      .limit(CHANGES_LIMIT);

    return {
      // Seeded values have no author, so no updatedAt
      items: items.map((i) => ({ ...i, updatedAt: i.updatedBy ? i.updatedAt.toISOString() : null })),
      changes: changes.map((c) => ({ ...c, changedAt: c.changedAt.toISOString() })),
    };
  }

  // Member view: no trainer names
  async getMemberPrices() {
    return this.database.db
      .select({
        id: priceItems.id,
        section: priceItems.section,
        title: priceItems.title,
        optionLabel: priceItems.optionLabel,
        amountUah: priceItems.amountUah,
      })
      .from(priceItems)
      .orderBy(asc(priceItems.sortOrder));
  }

  // Compare-and-set on the amount the trainer saw: concurrent edits can't silently overwrite each other
  async updatePrice(adminId: string, id: string, dto: UpdatePriceDto) {
    if (dto.amountUah === dto.expectedAmountUah) {
      const current = await this.current(id);
      if (current.amountUah !== dto.expectedAmountUah) throw this.changedMeanwhile(current);
      return { id, amountUah: current.amountUah };
    }

    const now = this.clock.now().toJSDate();
    return this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(priceItems)
        .set({ amountUah: dto.amountUah, updatedBy: adminId, updatedAt: now })
        .where(and(eq(priceItems.id, id), eq(priceItems.amountUah, dto.expectedAmountUah)))
        .returning({ id: priceItems.id, amountUah: priceItems.amountUah });
      if (!updated) throw this.changedMeanwhile(await this.current(id));

      await tx.insert(priceChanges).values({
        priceItemId: id,
        oldAmountUah: dto.expectedAmountUah,
        newAmountUah: dto.amountUah,
        changedBy: adminId,
        changedAt: now,
      });
      return updated;
    });
  }

  private async current(id: string) {
    const [item] = await this.database.db
      .select({ amountUah: priceItems.amountUah, updatedBy: admins.username })
      .from(priceItems)
      .leftJoin(admins, eq(admins.id, priceItems.updatedBy))
      .where(eq(priceItems.id, id))
      .limit(1);
    if (!item) throw new NotFoundException('Price not found');
    return item;
  }

  private changedMeanwhile(current: { amountUah: number; updatedBy: string | null }) {
    return new ConflictException({
      statusCode: 409,
      message: 'Price was changed by another trainer',
      amountUah: current.amountUah,
      updatedBy: current.updatedBy,
    });
  }
}
