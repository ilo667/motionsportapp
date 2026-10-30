import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

// Shared by main.ts and api/index.ts (Vercel): global setup goes here, never in one entrypoint
export function configureApp(app: INestApplication) {
  // Defaults incl. CSP are safe for a JSON API: browsers come via the /api rewrite, LiqPay and cron ignore headers
  app.use(helmet());
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.use(cookieParser());
}
