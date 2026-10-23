import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import type { INestApplication } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'http';

let app: INestApplication | undefined;

async function bootstrap(): Promise<INestApplication> {
  const instance = await NestFactory.create(AppModule);
  instance.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  });
  instance.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  instance.use(cookieParser());
  await instance.init();
  return instance;
}

module.exports = async (req: IncomingMessage, res: ServerResponse) => {
  if (!app) app = await bootstrap();
  app.getHttpAdapter().getInstance()(req, res);
};
