import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

// Shared by main.ts (local) and api/index.ts (Vercel), so both entrypoints get the same setup
export function configureApp(app: INestApplication) {
  // Security headers. A JSON API serves no pages, so helmet's defaults (incl. its CSP) are safe here:
  // browsers reach it through the Next.js /api rewrite; LiqPay callbacks and Vercel Cron ignore response headers
  app.use(helmet());
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.use(cookieParser());
}
