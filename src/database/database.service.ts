import {
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResultRow } from 'pg';

export type Queryable = Pick<Pool | PoolClient, 'query'>;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool?: Pool;

  constructor(private readonly configService: ConfigService) {}

  query<T extends QueryResultRow>(text: string, values?: unknown[]) {
    return this.getPool().query<T>(text, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  private getPool() {
    if (this.pool) {
      return this.pool;
    }

    const connectionString = this.configService.get<string>('DATABASE_URL');
    if (!connectionString) {
      throw new InternalServerErrorException('Falta configurar DATABASE_URL');
    }

    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
    return this.pool;
  }
}
