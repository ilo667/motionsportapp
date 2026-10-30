import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { validateEnv } from '../src/config/env';
import type { INestApplication } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'http';

// The promise, not the app: concurrent requests during a cold start share one bootstrap
let appPromise: Promise<INestApplication> | undefined;

async function bootstrap(): Promise<INestApplication> {
  validateEnv();
  const instance = await NestFactory.create(AppModule);
  configureApp(instance);
  await instance.init();
  return instance;
}

module.exports = async (req: IncomingMessage, res: ServerResponse) => {
  // Don't cache a failed start
  appPromise ??= bootstrap().catch((err: unknown) => {
    appPromise = undefined;
    throw err;
  });
  const app = await appPromise;
  app.getHttpAdapter().getInstance()(req, res);
};
