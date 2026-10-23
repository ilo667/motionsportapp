import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from './schema';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  readonly db = drizzle({ client: this.pool, schema });

  async onModuleDestroy() {
    await this.pool.end();
  }
}
