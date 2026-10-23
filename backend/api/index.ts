import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import type { INestApplication } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'http';

let app: INestApplication | undefined;

async function bootstrap(): Promise<INestApplication> {
  const instance = await NestFactory.create(AppModule);
  configureApp(instance);
  await instance.init();
  return instance;
}

module.exports = async (req: IncomingMessage, res: ServerResponse) => {
  if (!app) app = await bootstrap();
  app.getHttpAdapter().getInstance()(req, res);
};
