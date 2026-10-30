// Locally the variables come from backend/.env; on Vercel the platform sets them
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { validateEnv } from './config/env';

async function bootstrap() {
  validateEnv();
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
