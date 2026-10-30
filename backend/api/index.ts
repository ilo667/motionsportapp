import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { validateEnv } from '../src/config/env';
import type { INestApplication } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'http';

// The bootstrap itself, not its result: Vercel sends several requests to one instance at once, and those arriving
// during a cold start must wait for the same Nest instead of each starting their own
let appPromise: Promise<INestApplication> | undefined;

async function bootstrap(): Promise<INestApplication> {
  validateEnv();
  const instance = await NestFactory.create(AppModule);
  configureApp(instance);
  await instance.init();
  return instance;
}

module.exports = async (req: IncomingMessage, res: ServerResponse) => {
  // A failed start is not kept: the next request tries again
  appPromise ??= bootstrap().catch((err: unknown) => {
    appPromise = undefined;
    throw err;
  });
  const app = await appPromise;
  app.getHttpAdapter().getInstance()(req, res);
};
